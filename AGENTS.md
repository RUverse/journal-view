# Journal View contributor guide

Journal View is an Obsidian plugin that presents daily notes as one continuous,
editable timeline. See [README.md](README.md) for behavior and installation, and
[ROADMAP.md](ROADMAP.md) for planned work.

## Development

- Use TypeScript and Obsidian APIs; keep UI styling in `styles.css`.
- Run `npm run typecheck` while developing and `npm run build` before handing
  off changes. The build output, `main.js`, is intentionally ignored.
- Preserve user content: flush pending edits during teardown and handle vault
  writes, renames, and concurrent file creation defensively.
- Obsidian's embedded Markdown editor is an internal API. Keep access isolated
  in `src/editor.ts`, guard failures, and retain the plain-text fallback.

## Code map

- `src/main.ts`: plugin lifecycle, commands, and view registration
- `src/view.ts` / `src/day.ts`: timeline virtualization and per-day UI
- `src/dailyNotes.ts` / `src/noteIndex.ts`: note resolution and indexing
- `src/editor.ts` / `src/saveQueue.ts`: editing and durable writes
