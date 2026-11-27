---
name: pr-description
description: Write or revise a Pikos pull request's title and description. Use before every `gh pr create` or `gh pr edit --body`, and when asked to tidy PR descriptions. Covers the one shape every description takes, what counts as evidence, and the check CI runs on it.
---

# Pull request descriptions

Every Pikos pull request reads the same way, so a reviewer finds the why, the changes and the
proof in the same place each time. `scripts/check-pr-body.mjs` checks the shape, and CI runs it
on every pull request. This file covers what the check can't judge.

## The shape

```markdown
One or two plain sentences: what this is for, and why now.

## What changes

- **A bolded one-line claim.** A sentence of why at most.

## Migrations          (only when the pull request adds one)

## Evidence

What was run, and what it showed.

## Try by hand         (only when there's something to try)

What a person should check that no test here proves, and when.
```

No other headings, and the sections stay in that order. The title is a commit subject:
`type(scope): subject`, lowercase, saying what the change does.

## The opening

What the pull request is for, in words someone who hasn't read the code would follow. Lead with
the problem it fixes or the thing it makes possible. Two sentences at most, and no identifiers:
they go in the sections. "A red scheduled run never became tracked work, and pull requests
failed for things they didn't change" beats "Adds `ci-result` and an issue-filing step."

A release pull request links its release notes page here. What changed for people goes in those
notes, never in the description.

## What changes

One bullet per decision a reviewer needs, not one per file or commit, and seven at most. Each
opens with a bolded claim stating what now happens, then at most one sentence of why, or the
limit it sets. Technical detail is welcome. A bullet the diff already tells the reviewer gets
cut. Past seven, group related changes under one claim; a pull request that still needs more is
usually two.

## Migrations

One line per migration: its number and what it changes. Say if it's one-way.

## Evidence

The proof the diff can't carry. Name what was run and what it showed:

- a test confirmed failing on the old code, and which one
- numbers before and after, with where each came from
- a real run, like a dry run, a rerun on the same runner, or a staging device, and its result
- a QA row a person drove, by its ID

"CI is green" or "tests pass" alone isn't evidence, because the checks on the pull request
already say so.

## Try by hand

The list the maintainer works through before merging or releasing. Each item says what to do,
when (before merge, after merge, or at release), and what a pass looks like: a screen to drive on
staging, a QA row by its ID, a scheduled run to watch, or a setting to change. Name a known limit
here too, so whoever tries it knows where to push. Leave the section out when there's nothing to
try. Don't write "nothing".

## Before you post

1. Write the body to a file in the scratchpad.
2. `node scripts/check-pr-body.mjs --title "<title>" <file>` and fix what it reports.
3. `gh pr create --title "<title>" --body-file <file>`, or `gh pr edit <n> --body-file <file>`.

When revising a description, keep every fact and move it into the shape. Never invent evidence.
Look for it before giving up: tests the pull request added or changed (`gh pr diff <n>`), its
commits, its comments, and CI's runs on it. Name a test only when the diff shows it. If
nothing turns up, Evidence says so in one line.
