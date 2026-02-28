---
name: skill-creator
description: Create or update a skill in .agent/skills/. Use when adding reusable workflows, patterns, or playbooks to the project's skill library — especially for recurring operations that benefit from consistent execution.
compatibility: Claude Code, agentskills.io SKILL.md format
---

# Create or Update a Skill

## When skills are worth writing

A skill is worth creating when the same type of task recurs and:
- Consistent execution matters (wrong steps cause real problems)
- There are non-obvious decisions or gotchas to encode
- The workflow has 3+ steps that benefit from a checklist

Don't write a skill for one-off operations or things that are already self-evident from the code.

## Core principles

**The context window is a public good.** Every line in a skill file costs tokens on every activation. Challenge whether each paragraph earns its place. A skill that loads 400 lines of marginally useful context is worse than one that loads 40 lines of essential guidance.

**Match specificity to fragility.** High-risk, error-prone operations (Tauri commands, migrations, CI setup) warrant explicit step-by-step instructions. Flexible creative tasks (writing a new component) need principles, not scripts.

**Progressive disclosure.** The `description` field loads on every session startup — keep it under 200 characters and make it keyword-rich so activation is accurate. The body loads only when the skill is triggered — keep it under 500 lines. Move detailed reference material to `references/` files and link to them.

## Directory structure

```
.agent/skills/<skill-name>/
  SKILL.md          # Required — frontmatter + instructions
  references/       # Optional — detailed docs loaded on demand
  scripts/          # Optional — executable code for deterministic tasks
  assets/           # Optional — templates, schemas, boilerplate
```

## SKILL.md format

```yaml
---
name: skill-name          # lowercase, hyphens, matches directory name
description: What it does and when to use it. Include keywords for accurate triggering. Max 1024 chars.
compatibility: Environment or tool requirements (optional)
---
```

Body: step-by-step instructions, examples, edge cases. No format restrictions.

## Naming rules

- Lowercase letters, numbers, hyphens only
- No consecutive hyphens, no leading/trailing hyphens
- Must match the parent directory name exactly

## Creation checklist

1. Identify the recurring operation and write 2–3 concrete use cases
2. Decide what goes in `SKILL.md` vs `references/` — anything that's only needed sometimes belongs in `references/`
3. Create the directory: `mkdir -p .agent/skills/<name>`
4. Write `SKILL.md` — frontmatter first, then body
5. Test it: mentally walk through a real use case against the skill. Does it give enough context? Too much?
6. If the skill references other skills, use relative paths: `../other-skill/SKILL.md`
