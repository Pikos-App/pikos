---
name: create-plan
description: Transform a complex or ambiguous request into a structured, actionable implementation plan before writing any code. Use when a task has multiple steps, unclear scope, or requires architectural decisions. Outputs a plan for user approval — no file modifications until approved.
compatibility: Claude Code read-only planning phase
---

# Create a Plan

Use this skill when a request is complex enough that diving straight into code risks wasted work or misaligned direction.

## When to use

- Task touches more than 2–3 files
- Multiple valid approaches exist
- Architectural decisions need to be made
- Requirements are ambiguous
- User asks "how should we..." or "what's the best way to..."

## Workflow

### 1. Scan the relevant context (read-only)

Read the files most relevant to the task:
- Feature docs in `.agent/features/` for the domain
- Existing code in the affected area
- Related skill files in `.agent/skills/` if a skill applies
- `CURRENT.md` for active decisions that constrain options

Do not read everything — scan just enough to understand the shape of the solution.

### 2. Ask at most one clarifying question

If something is genuinely ambiguous and would change the plan significantly, ask one focused question. Skip the question if you can make a reasonable call yourself.

### 3. Write the plan

Output a single coherent plan with this structure:

---

**Intent**: One sentence describing what this plan accomplishes and why.

**Scope**
- In: what will be built/changed
- Out: what is explicitly not included

**Steps** (6–10 items, verb-first, atomic)
1. ...
2. ...

**Open questions** (≤3, only genuine blockers)
- ...

---

### 4. Wait for approval

Do not create, edit, or delete any files until the user approves the plan. If the user requests changes to the plan, revise it before proceeding.

## Rules

- Steps must be concrete and discoverable — "create `VaultContext.tsx` with `pages` and `activePage` state" not "set up context"
- Keep scope boundaries explicit — saying what's out is as valuable as what's in
- 6–10 steps is the right size; fewer means the task is too simple to need a plan, more means you need to break it into sub-plans
- Include a testing or verification step when the task is non-trivial
