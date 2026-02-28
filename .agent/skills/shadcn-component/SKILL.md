---
name: shadcn-component
description: How to add a shadcn/ui component to the Pikos monorepo. Use when adding a pre-built shadcn component or creating a custom component in packages/ui.
compatibility: shadcn@latest (new-york style), Tailwind CSS v4, React 19
---

# Add a shadcn/ui Component

## Install a pre-built component

Run from `apps/desktop/`:

```bash
npx shadcn@latest add <component-name>
```

Note: the package is `shadcn` (not `shadcn-ui` — that's the old name).

This adds files to `apps/desktop/src/components/ui/`.

## Use in features

```typescript
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog'
```

Import directly from the component path within `apps/desktop`. Do not import from `packages/ui` for desktop-only components — that package is for truly shared components.

## Styling rules

- Tailwind CSS v4 — use `@theme` directive in CSS, no `tailwind.config.js`
- Dark mode first — all components must look correct in dark mode without extra work
- Use CSS variables from the design system (`--background`, `--foreground`, `--primary`, etc.)
- Do not use arbitrary Tailwind values when a design token exists
- Component variants use `cva()` from `class-variance-authority`

## Creating a custom shared component in packages/ui

Only put components here if they'll be used by more than one app (desktop + mobile):

1. Create `packages/ui/src/components/<ComponentName>.tsx`
2. Export from `packages/ui/src/index.ts`
3. Keep it generic — no feature-specific logic in `packages/ui`
4. Import in features: `import { ComponentName } from '@pikos/ui'`

## shadcn config

- Config: `apps/desktop/components.json`
- Style: `new-york`
- Base color: `zinc`
- CSS variables: yes
