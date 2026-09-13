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

## Applies, not yet actioned

### Reminders cannot be fired by a loop

The desktop wakes a Rust task every clock minute and queries SQLite. iOS
suspends that within seconds of backgrounding, so nearly every reminder would
silently never fire. The model has to inverse: compute a rolling horizon and
hand it to the OS in advance, through `UNUserNotificationCenter`.

Four complications the spike names, all of which survive the change of UI layer:

- a recurring series has no end, so the horizon needs a bound;
- iOS caps pending notifications (the spike says ~64, and flags it as needing
  confirmation);
- quiet hours have to be applied at *schedule* time, not at fire time;
- any edit invalidates the scheduled set.

This is net-new logic on any path. `apps/ios/README.md` lists notifications as
missing; this is the shape of what is missing.

### Google OAuth and background sync are structurally blocked

Both are deferred with external calendar sync, but the reasons are worth having
written down so they are not rediscovered:

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

That last line is the one that matters for the XCFramework: bundled SQLite
compiles for iOS, and so do reqwest+rustls and oauth2. It was the largest
unknown in any plan that shares Rust, and it is answered.

Two gaps against what `scripts/build-ios-framework.sh` actually asks for. It also
builds `x86_64-apple-ios` (Intel simulator) and, since the host-test change,
`aarch64-apple-darwin` and `x86_64-apple-darwin`. Those were not part of the
spike's verification, and `rustup target add` may be a first run for them.

Outstanding, and both GUI and both Alex's: sign into Xcode under Settings →
Accounts, and pair a physical device once.

## Still worth reading, if it can be found

`guides/mobile-design.md` is described as the phone design language and
explicitly shell-agnostic. It is not in this repository. The screens built so
far — page list, editor, quick add, calendar — were designed without it, so it
is worth retrieving and diffing against them rather than assumed to agree.
