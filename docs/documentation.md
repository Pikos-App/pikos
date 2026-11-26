# Where docs go

Every fact about Pikos has one home. This page is how to find it, and where to put a new one.

## Start at the code

Put a fact in the first place on this list that can hold it. Anything else that needs the
fact links there.

1. **A name or a type.** If a better function name or a narrower type says it, no prose
   is needed.
2. **A doc comment** on the declaration that owns the behaviour: TSDoc, or `///` in Rust
   and Swift. It states what a caller can rely on, meaning the inputs, the result, and the
   errors, in a line or two. The internals, the callers, and anything the signature already
   says stay out.
3. **An inline comment** at the line that needs it, for the reason the code can't show. Why
   this approach, a constraint you can't see from here, or how it breaks. Never what the
   line does.
4. **The folder's README.** What the folder is for, where new code in it goes, and any rule
   every caller has to follow. Skip the file tour, the copy of the API, and the code
   samples, because they drift the first time the code moves.
5. **The folder's `GLOSSARY.md`**, for the terms that folder owns. Terms the whole product
   uses stay in `docs/glossary.md`. Define a term once and link to it everywhere else.
6. **A page in `docs/`**, only for a rule or a model that spans the repo with no one folder
   owning it. `time-handling.md` is the example.

## Agent instructions

The root `AGENTS.md` loads in every agent session, so it holds instructions and pointers
and nothing else. What to do, what never to do, and what to read first. A fact about the
system doesn't belong there. It falls out of step with the code, and an agent keeps
trusting it.

A folder gets its own `AGENTS.md` in two cases. It has a rule that applies only inside it,
like regenerating the bindings instead of editing them by hand. Or it has a README an agent
should read before starting, since an agent won't open one unprompted. The folder's file
extends the root one and never overrides it. It doesn't repeat the README, the root file,
or anything a lint rule already catches.

Agents don't edit an `AGENTS.md` on their own. They report what's stale, and a person makes
the change.

A skill is the steps for one recurring task. When more than one skill needs a rule, or
people need it too, the rule goes in a README or a `docs/` page and the skill links to it.

## What a doc never says

Docs describe the system as it is now. Progress, counts, rollout state, plans, and issue or
PR numbers go in the PR. What was tried and dropped goes in a decision record, which keeps
its ID for good and gets superseded instead of edited.

Decision records and planning notes aren't committed, so no committed file links to one.
When a doc depends on a decision, it gives the rule and the reason in its own words.

If a lint rule or a test can enforce a rule, write the check and delete the prose.

## When two docs disagree

Neither wins on its own. The code settles it, and whichever doc or comment is wrong gets
fixed. When the two say the same thing, one of them is a copy: keep the one in the right home
from the list above and delete the other.
