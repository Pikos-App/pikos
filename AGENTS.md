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
4. If the item names a `.agent/features/*.md`, read it before writing code.
5. Settled decisions: `adr <id>`, or `adr find <word>`.
6. An unfamiliar term, like head, skip-set, or mirror layer, is in `docs/glossary.md`.
7. A spec that's unclear or contradicts itself stops the task. Ask.

## Working on a live app

`main` stays shippable as a hotfix base.

- Branch from `main` as `type/short-desc`, hotfixes included. Docs, comments, tooling,
  typos, and obvious one-liners may go straight to `main`. In doubt, branch.
- Know the target release before starting. The version ladder is `adr 43`.
- If a change could break a tested, working surface, stop. Say what's at risk and what
  manual QA you'd want, and wait.
- Data never leaves the device without an explicit user action, so nothing reports a
  failure for us. Surface every failure to the user. Never degrade silently.

## Debugging

Read `~/Library/Logs/app.pikos.desktop/pikos.log` before any static analysis (`.dev` and
`.staging` for those builds). It holds both Rust and the webview, including swallowed
promise rejections, failed Tauri commands, and SQLite errors.

## Writing code

Lint, the import-boundary check, and `scripts/source-audit.sh` enforce most of the house
rules, and their messages say what to do instead. When one blocks you, fix the code. A
disable needs a `-- reason` saying why.

Two React rules lint can't see:

- Logic that follows a user action goes in the handler, not an effect. Effects only
  bridge to external systems.
- The dependency-array check is off on purpose. Don't add a value just because the effect
  reads it, because a non-stable one loops forever.

Test logic that branches, not pass-through components or layout. Which layer proves a
change, from unit to e2e to a person, is `.agent/guides/testing-layers.md`. Read it before
deciding something needs driving by hand.

## Finishing a task

`pnpm verify` is the gate, and it always runs the full unit suite (`adr 97`). For Rust,
also run `cargo test -p <crate>` and `cargo clippy -p <crate> --all-targets -- -D
warnings`.

Self-audit the diff. There's no per-task review subagent. Mechanical subagents, like broad
searches and verification passes, run on `model: sonnet`.

Then `kit done pkos <ID>`, never `rm`, and move the item's row to its release page's
"Landed" list with the date. If a skill proved wrong or incomplete, fix it now.
