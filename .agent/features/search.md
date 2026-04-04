# Feature: Search — Future Work

## Current State
Search palette (Cmd+K) shipped with FTS5 full-text search, recent pages, highlighted results.

## Unbuilt Features

- **Cmd+P title search**: Fuzzy search via fuse.js against in-memory pages (immediate, no DB). Separate from Cmd+K content search.
- **Cmd+P double-tap → content search**: Switch from title to FTS5 content search on second press.
- **Actions palette**: Cmd+K also surfaces actions (create page, switch workspace, open settings) alongside search results.
- **NL parser integration**: Parse input like "standup @tomorrow 9am #work" to pre-fill metadata on page creation. Parser exists in `packages/core/src/nlp/parser.ts` but not wired to search palette.
