---
name: monorepo-setup
description: One-time guide for initializing the Pikos Turborepo monorepo from the Svelte prototype. Use when executing GOO-7 + GOO-26 (React migration). Covers what to delete, what to move, and step-by-step scaffold.
compatibility: pnpm workspaces, Turborepo, Tauri v2, React 19
---

# Monorepo Setup (One-time)

## What to delete

```
src/                    # entire Svelte frontend
svelte.config.js
tailwind.config.js      # Tailwind v4 uses @theme in CSS, no config file
postcss.config.js
components.json         # replaced by shadcn init in apps/desktop
package-lock.json       # switching to pnpm
```

## What to keep / move

```
src-tauri/          →  apps/desktop/src-tauri/
src/keyboard/registry.ts  →  apps/desktop/src/shared/keyboard/registry.ts
src-tauri/icons/    →  apps/desktop/src-tauri/icons/  (already there)
```

Note: `registry.ts` can be copied as-is. Menu shortcuts (Cmd+N, Cmd+W) will move to Tauri menu event listeners when GOO-24 is built — see `../keyboard-shortcut/SKILL.md`.

## Step-by-step

### 1. Root package.json

```json
{
  "name": "pikos",
  "private": true,
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "lint": "turbo lint",
    "test": "turbo test"
  },
  "devDependencies": { "turbo": "latest" },
  "packageManager": "pnpm@latest"
}
```

### 2. pnpm-workspace.yaml

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

### 3. turbo.json

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "dev": { "persistent": true, "cache": false },
    "lint": {},
    "test": { "dependsOn": ["^build"] }
  }
}
```

### 4. Scaffold directories

```bash
mkdir -p apps/desktop/src apps/mobile apps/marketing
mv src-tauri apps/desktop/src-tauri
```

Note: `apps/marketing/` is a placeholder for the Astro marketing site (GOO-53). Leave empty for now — scaffold the Astro app when Phase 3 begins.

### 5. apps/desktop/package.json

```json
{
  "name": "@pikos/desktop",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "tauri": "tauri",
    "lint": "biome check src"
  }
}
```

### 6. Update tauri.conf.json

```json
{
  "productName": "Pikos",
  "identifier": "com.alex.pikos",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  }
}
```

### 7. Scaffold packages/core

```json
{
  "name": "@pikos/core",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" }
}
```

Zero Tauri, React, or DOM imports in this package.

### 8. Scaffold packages/ui

```json
{
  "name": "@pikos/ui",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "peerDependencies": { "react": "^19.0.0" }
}
```

### 9. Install deps in apps/desktop

```bash
cd apps/desktop
pnpm add react react-dom
pnpm add -D @types/react @types/react-dom @vitejs/plugin-react typescript vite
pnpm add lucide-react react-resizable-panels cmdk date-fns
pnpm add @tauri-apps/api @tauri-apps/plugin-dialog @tauri-apps/plugin-store
pnpm add -D babel-plugin-react-compiler
```

### 10. apps/desktop/vite.config.ts

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react({ babel: { plugins: ['babel-plugin-react-compiler'] } })],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: 'chrome105', minify: !process.env.TAURI_DEBUG ? 'esbuild' : false },
})
```

### 11. apps/desktop/index.html

```html
<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width" /></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

### 12. shadcn init in apps/desktop

```bash
cd apps/desktop
npx shadcn@latest init
# new-york style, zinc base, Tailwind v4, CSS variables
```

### 13. Biome at repo root

```bash
pnpm add -D @biomejs/biome
npx biome init
```

## Acceptance Criteria

- `pnpm tauri dev` from `apps/desktop/` boots a React app in Tauri window
- `packages/core` has zero Tauri/React/DOM imports
- `package-lock.json` deleted; `pnpm-lock.yaml` committed
- All Svelte files gone from `src/`
