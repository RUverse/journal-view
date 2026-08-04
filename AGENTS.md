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

## Testing

There are no automated tests: nearly everything here is an interaction against
Obsidian's own runtime. Verify changes in the throwaway vault instead of a real
one, and say what you actually exercised rather than what should follow.

```bash
npm run test-vault   # builds/repairs test-vault/, gitignored, plugin symlinked in
```

Add it in Obsidian once (vault switcher -> Manage vaults -> Open folder as vault),
after which the `obsidian` CLI can drive it without any clicking:

```bash
obsidian vault=test-vault command id=journal-view:open
obsidian vault=test-vault eval code='app.workspace.getLeavesOfType("journal-view")[0].view.sections.length'
```

Two traps, both of which look exactly like the feature being broken:

- **Focus events need a focused document.** Chromium will not dispatch them while
  `document.hasFocus()` is false, so anything driven from the terminal with the
  window in the background skips every focus path. Enable focus emulation first
  (`dev:debug on`, then `Emulation.setFocusEmulationEnabled`) and disable it after.
- **Plugins are not hot-reloaded.** `npm run build` does not touch the running
  window; disable and re-enable the plugin to pick the new code up.

`test-vault/README-TESTING.md` has the full recipes and the checks worth running.

## Code map

- `src/main.ts`: plugin lifecycle, commands, and view registration
- `src/view.ts` / `src/day.ts`: timeline virtualization and per-day UI
- `src/dailyNotes.ts` / `src/noteIndex.ts`: note resolution and indexing
- `src/editor.ts` / `src/saveQueue.ts`: editing and durable writes

The view delegates to four collaborators, each holding the view through a small
host interface it implements:

- `src/anchor.ts`: pins the reader's place and spends the top spacer on drift
- `src/editorWindow.ts`: picks which days are live editors, and guards the
  scroll position while one is mounted
- `src/dayWalk.ts`: day offsets, dates and index keys, including hidden days
- `src/toolbar.ts`: the toolbar strip; `src/scroll.ts`: pure scroll geometry

`src/datePicker.ts` is the toolbar's calendar: a scrolling column of months that
hangs off the view rather than being part of it, and moves the journal by date.
