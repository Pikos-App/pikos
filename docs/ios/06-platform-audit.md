# What iOS breaks, regardless of the UI layer

Carried over from the Tauri-era mobile spike (handoff written 2026-09-13) and
re-read against the Swift path. Its architecture is obsolete; this half of it is
not, because every item is about iOS rather than about what draws the screen.

Two caveats on provenance. The branch that work sat on (`feat/mobile`) was never
pushed, and the documents it cites — `features/mobile-app.md`,
`guides/mobile-design.md`, the `PKOS-00xx` decisions — are not in this
repository, so none of it could be re-read at the source. What follows is the
handoff's own summary, marked for what has since been verified here and what has
not.

## Acted on

### The keychain gate silently dropped iOS — fixed

`crates/pikos-calendar-sync/Cargo.toml` gated the `apple-native` keyring backend
to `cfg(target_os = "macos")`. iOS is `target_os = "ios"`, so it fell into the
`not(macos)` arm and got `keyring` with **no backend feature at all** — which is
a mock store with no persistence. Credentials would appear to save and be gone
on the next launch, with nothing logged and no error raised.

Verified present in this tree after the sync merge, and fixed: both arms now
name both Apple platforms. The spike reported carrying an identical fix
uncommitted on `feat/mobile`; since that branch is unavailable, this was made
directly rather than cherry-picked.

### The database's protection class was left to chance — now chosen

iOS assigns a data-protection class to every file, and the strictest one makes a
file unreadable whenever the device is locked, surfacing as open and write
failures rather than as anything naming the cause. That is not hypothetical for
this app: **a Today widget refreshes on the lock screen**, which is precisely
when the app is backgrounded and the device is locked.

`WorkspaceLocation.applyProtectionClass()` now sets
`.completeUntilFirstUserAuthentication` on the database and its `-wal`/`-shm`
sidecars, applied by `WorkspaceStore.start()` after the open. The file stays
encrypted at rest and unreadable on a device not unlocked since boot — the
property worth having — without vanishing every time the screen locks, which is
the property that would make the widget lie.

Still needs confirming on a device, with the device actually locked. That is the
spike's own advice and it has not been done.

### Reminders cannot be fired by a loop — inverted

The desktop wakes a Rust task every clock minute and queries SQLite. iOS
suspends that within seconds of backgrounding, so nearly every reminder would
silently never fire. The model is inverted on the phone: the workspace is
asked what will fire over the next fourteen days, each answer becomes a
`UNNotificationRequest` the OS delivers on its own, and the whole plan is
rebuilt whenever anything could have changed it.

The four complications the spike named, and what became of each:

- **A recurring series has no end.** The horizon is the bound: fourteen days,
  and the recurring enumeration runs to the horizon plus the longest lead.
- **iOS caps pending notifications at 64.** Confirmed — the system keeps the
  sixty-four soonest and drops the rest silently. The phone plans sixty, soonest
  first, so a drop is ours to notice rather than the OS's to hide.
- **Quiet hours at schedule time.** Deliberately not implemented. The desktop
  suppresses a reminder that comes due inside them; on iOS the system's Focus
  modes are the same control, and a second copy applied at schedule time would
  silence a reminder the user's Focus schedule would have let through.
- **Any edit invalidates the set.** The plan follows `WorkspaceStore.dataVersion`,
  debounced a second, and is rebuilt on the way to the background and by a
  `BGAppRefreshTask` that asks for a wake every twelve hours — a request, not a
  promise, which is why the horizon is measured in days.

The rules deciding _what_ reminds are the desktop's six `due_*` arms composed
over a forward window (`pikos_db::reminder_horizon`), so a reminder rings on
the phone for exactly the reasons it rings on the desktop. What the phone does
not do is write the desktop's fired log: the OS delivers without waking the
app, so the moment of firing is never seen — and nothing needs it, since the
plan is rebuilt from the workspace rather than from history.

## Applies, not yet actioned

### Google OAuth and background sync are structurally blocked

Still true, and now load-bearing rather than hypothetical: CalDAV sync ships on
iOS (`Workspace::connect_caldav` and friends, `CalendarSyncScreen`), and these
two are exactly what it stops short of. The screen says so to the user rather
than leaving it to be discovered.

- The grant waits on a **loopback TCP listener inside the app process**. Leaving
  for the browser starts iOS suspending that process, so the wait outlives the
  app. Needs `ASWebAuthenticationSession`; the PKCE half is transport-agnostic
  and ports unchanged.
- The 5-minute calendar poll is an **in-process timer** and stops when
  suspended. Needs the Background Tasks framework.

### Vault import has no filesystem to scope to

Desktop reads are scoped to `$HOME/**` so a vault import can reach anywhere. iOS
has no such directory; everything goes through the document picker. Relevant
whenever import reaches the phone, and a reason not to assume the import code
ports as-is.

## Does not apply to the Swift path

- **`menu.rs`, `window_state.rs`** — desktop-only, and `tauri::menu` is
  `cfg(desktop)` upstream. There is no Tauri here, so there is nothing to port
  rather than something to exclude.
- **`db/watch.rs`** — exists so the CLI and the app can share a workspace file.
  No second process reaches an iOS container. Verified: `crates/pikos-ffi`
  references it nowhere, so the boundary already excludes it.

## The toolchain question is settled

Exercised on 2026-09-11, per the handoff — not merely installed:

- Xcode 26.6, iOS SDK 26.5, simulator SDK present, developer directory switched.
- `aarch64-apple-ios` and `aarch64-apple-ios-sim` added.
- **All three crates cross-compile to `aarch64-apple-ios`**: `pikos-recurrence`,
  `pikos-db`, `pikos-calendar-sync`.

That last line is the one that matters: bundled SQLite compiles for iOS, and so
do reqwest+rustls and oauth2. It was the largest unknown in any plan that shares
Rust, and it is answered.

It is not, however, the same set of crates the XCFramework builds, and the
difference is worth stating precisely rather than assuming it is covered.

**The verified three are not the built one.** `scripts/build-ios-framework.sh`
builds `pikos-ffi`, which did not exist when the spike ran. Neither did
`pikos-core`. What the spike verified reaches them transitively —
`pikos-ffi` → `pikos-db` → bundled SQLite is the risky edge and it is
answered — but two things are genuinely unverified:

- **`pikos-core`'s own dependencies.** `fancy-regex`, `chrono-tz` and `url`, all
  pure Rust with no system libraries. Low risk, but nobody has compiled them for
  a phone.
- **The link mode.** The spike compiled library crates; the XCFramework needs a
  `staticlib`, which is a different output. `uniffi` exists to be linked into
  iOS apps, so this is expected to work — but expected is not measured.

**`pikos-calendar-sync` is now in the XCFramework.** It was verified to
cross-compile and then sat unused, because it was not a dependency of
`pikos-ffi`. It is one now, which makes the keychain fix above live rather than
inert and pulls reqwest+rustls into the iOS static library for the first time.
What it does _not_ pull in is the scheduler: `run_sync_loop` is never called
from the FFI, because an in-process timer is precisely what iOS suspends.

Two consequences worth knowing before the first device build. The binary grows
by whatever rustls and reqwest cost. And App Transport Security will refuse a
plain-`http` CalDAV server — correct behaviour, and the right answer is a
certificate on the server rather than an ATS exception in the app.

**Two targets were never in the spike's set.** The script also builds
`x86_64-apple-ios` (Intel simulator) and, since the host-test change,
`aarch64-apple-darwin` and `x86_64-apple-darwin`. Expect `rustup target add` to
do real work on the first run.

**One thing fixed while reading this.** The script built `pikos-ffi` without
`--lib`, so it cross-compiled the crate's `uniffi-bindgen` binary to iOS too —
a host-only tool that generates Swift and is never linked into the app. Wasted
time at best, a link failure in something irrelevant at worst. Narrowed.

Outstanding, and both GUI and both Alex's: sign into Xcode under Settings →
Accounts, and pair a physical device once.

## The line counts have moved a long way

The handoff answers "the plan's first open question" with a measured table —
`crates/` at 21,540 lines of Rust, `packages/core` at 10,506 of TypeScript. Its
copy reaching this session was truncated mid-row, so the rest of that table was
not readable; and the merge with `feat/external-calendar-sync` has since made
both numbers badly out of date. Re-measured on this branch:

|                                   | Lines  |
| --------------------------------- | ------ |
| `crates/` (Rust, excluding tests) | 50,414 |
| `crates/` (Rust, all)             | 56,319 |
| `packages/core/src` (TypeScript)  | 27,414 |
| `apps/desktop/src` (TypeScript)   | 46,249 |
| `apps/ios` (Swift, hand-written)  | 4,695  |

The shared Rust has more than doubled, and so has `packages/core`. Whatever the
original table concluded about the portable fraction, it was concluding it about
a much smaller codebase.

## Still worth reading, if it can be found

`guides/mobile-design.md` is described as the phone design language and
explicitly shell-agnostic. It is not in this repository. The screens built so
far — page list, editor, quick add, calendar — were designed without it, so it
is worth retrieving and diffing against them rather than assumed to agree.
