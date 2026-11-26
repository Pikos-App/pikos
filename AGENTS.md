# Pikos

The code outranks every doc, this file included. If the two disagree, do what the code
does and correct the doc. The exception is a stale `AGENTS.md`: leave it, and say what's
wrong to the person you're working with, or in `.agent/QUESTIONS.md` on an unattended run.

Where a new fact or doc belongs is `docs/documentation.md`.

## Starting a task

Planning lives in `.agent/`, which isn't committed.

1. `.agent/PROJECT.md` says what Pikos is and where it stands.
2. `.agent/releases/README.md` names the release marked `planning`. Take the highest
   item its page lists from `.agent/backlog/index.md`, or the top item if none is in
   planning, and open only that item's file.
3. `.agent/QUESTIONS.md`: act on any question with a filled-in `**Answer:**` first.
4. If the item names a `features/*.md`, read it before writing code.
5. Settled decisions: `adr <id>`, or `adr find <word>`. Record a new one with
   `adr new "<headline>"`, then `adr index`.
6. An unfamiliar term, like head, skip-set, or mirror layer, is in `docs/glossary.md`.
7. A spec that's unclear or contradicts itself stops the task. Ask.

## Working on a live app

`main` stays shippable as a hotfix base.

- Branch from `main` as `type/short-desc`, hotfixes included. Docs, comments, tooling,
  typos, and obvious one-liners may go straight to `main`. In doubt, branch.
- Know the target release before starting. The version ladder is `adr 43`.
- If a change could break a tested, working surface, stop. Say what's at risk and what
  manual QA you'd want, and wait.

## Debugging

Read `~/Library/Logs/app.pikos.desktop/pikos.log` before any static analysis (`.dev` and
`.staging` for those builds). It captures Rust and the webview, including swallowed promise
rejections, failed Tauri commands, and SQLite errors, and usually names the exact error.

## Finishing a task

`pnpm verify` is the gate. It always runs the full unit suite through turbo's cache, so
don't scope it to the diff (`adr 97`). Rust isn't covered by it, so also run
`cargo test -p <crate>` and `cargo clippy -p <crate> --all-targets -- -D warnings`.

Self-audit the diff. There's no per-task review subagent. Mechanical subagents, like broad
searches and verification passes, run on `model: sonnet`.

Then:

1. `kit done pkos <ID>` removes the item's file and index line. Never `rm`, and never
   mark it done in place. If the item belongs to a release, move its row to that page's
   "Landed" list with the date.
2. If a skill proved wrong or incomplete, fix it now.

## Planning files

- Build spec: `.agent/features/*.md`
- Guide too internal to publish: `.agent/guides/*.md`
- Decision with a rejected alternative: `.agent/decisions/`
- Where the project stands: `.agent/PROJECT.md`
- One release's scope, landed items, QA, and record: `.agent/releases/<version>/`
- The queue: `.agent/backlog/`

Only the queue is deleted. Everything else is kept once it's done: a decision is
superseded, never rewritten, and a dated QA sheet, audit, or review stays put. A handoff is
the exception and goes when its work lands. Before deleting anything, grep for what points
at it.

Committed files never cite a backlog ID or link into `.agent/` or `.claude/`. Neither is
committed, so the link is dead for every other reader.

## Product bar

- **Performance.** Every interaction feels instant. No component re-renders more than once
  per user interaction.
- **Privacy.** Data never leaves the device without an explicit user action. No telemetry
  and no hidden network calls, so silent degradation is the worst class of bug here:
  nothing reports it.
- **Approachability.** A non-technical user creates a task, writes a note, and schedules it
  without reading docs. Power features never get in the way.

## Code

- pnpm, never npm or yarn.
- `crates/pikos-db` owns DB logic for the desktop app and the CLI.
- Storage and DB access go through the storage adapter. Never reach SQLite or `invoke` a DB
  command from a component, or test mode stops being mockable. Other Tauri APIs may be
  used directly.
- Never use raw `Date` methods or manual date arithmetic. Use `date-fns`. `new Date()` for
  "now" is the one exception.
- Lucide icons only, never hand-rolled SVGs.
- One component per file, under 200 lines. Shared logic becomes a hook or utility.
- Discriminated unions over boolean flags for state with more than two modes.
- Shared constants go in `apps/desktop/src/shared/constants/`.
- `// SAFETY:`, `// sql-ok:`, and `// eslint-disable-next-line … -- reason` are required by
  the lint config and `scripts/source-audit.sh`. Never strip them.

## React

React Compiler is on.

- Never `useMemo`, `useCallback`, or `React.memo`.
- Never `setState` inside `useEffect`, and never use an effect to sync state with props.
  Compute derived state during render, or reset with a `key`.
- `useEffect` only bridges to external systems: DOM listeners, Tauri `listen()`,
  observers, timers, third-party libraries, SQLite loads on mount, or syncing a ref to a
  render value. Anything that follows a user action goes in the handler.
- Never write a ref during render.
- Don't add a value to a dependency array just because the effect reads it. A non-stable
  reference there loops forever.
- Controlled components over refs for form state.

## Tests

Test logic that branches: stores, hooks, and utilities. Not pass-through components or
pure layout. Which layer proves a change, from unit to e2e to a person, is
`.agent/guides/testing-layers.md`. Read it before deciding something needs driving by hand.

- Select by role, text, or placeholder. `getByTestId` is a last resort. Never select by CSS
  class or DOM structure.
- Mock boundaries, like storage adapters and Tauri IPC, never internal functions.
