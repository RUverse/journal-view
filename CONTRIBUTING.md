# Contributing to Journal View

Thanks for helping improve Journal View. Bug reports, feature ideas, documentation
fixes and code are all welcome.

## Reporting a bug

Search the [open issues](https://github.com/RUverse/journal-view/issues) first; if
your problem is already there, add what you see to that issue instead of opening a
new one. Otherwise, open an issue with:

- your Journal View and Obsidian versions, and your platform (macOS, Windows,
  Linux, iOS or Android)
- your daily-note setup: folder, date format and template, and whether they come
  from Obsidian's Daily notes core plugin, Periodic Notes or Journal View's own
  settings
- the steps that cause the problem, what you expected, and what happened instead
- any errors from the developer console (**View → Toggle Developer Tools** on
  desktop)
- other plugins involved, if the problem goes away when they are disabled

Journal entries are private. Reproduce the problem with made-up notes, and don't
paste real journal content or screenshots of it into an issue.

## Suggesting a feature

Open an issue that describes what you want to do and why, before you write the
code. Journal View aims to work with the daily notes people already have, without
plugin-specific formats, so a short discussion first helps find the approach that
fits. Issues labelled
[good first issue](https://github.com/RUverse/journal-view/labels/good%20first%20issue)
are a good place to start.

## Setting up

You need [Node.js](https://nodejs.org/) (CI uses version 24), npm and a desktop
copy of Obsidian.

```bash
git clone https://github.com/RUverse/journal-view.git
cd journal-view
git switch dev
npm ci
npm run dev          # rebuilds main.js whenever a source file changes
```

| Command              | What it does                                              |
| -------------------- | --------------------------------------------------------- |
| `npm run dev`        | Watches `src/` and rebuilds `main.js` with source maps    |
| `npm run build`      | Typechecks and builds the production `main.js`            |
| `npm run typecheck`  | Runs the TypeScript compiler without emitting files       |
| `npm run lint`       | Runs Obsidian's plugin review rules on code and CSS       |
| `npm run test-vault` | Creates or repairs a throwaway vault for manual testing   |

`main.js` is a build output and is not committed.

## Testing your change

There are no automated tests: nearly everything Journal View does is an interaction
with Obsidian itself. Test in the throwaway vault, never in your real one.

```bash
npm run test-vault
```

This creates `test-vault/` (ignored by Git) with sample daily notes and the plugin's
build files linked in, so it always loads the latest build. Add it to Obsidian once
through the vault switcher (**Manage vaults → Open folder as vault**). The script
also writes `test-vault/README-TESTING.md`, which lists the checks worth running
and shows how to drive the vault from the `obsidian` command line.

Two things look exactly like a broken feature:

- **Obsidian does not hot-reload plugins.** After a rebuild, turn Journal View off
  and on again in **Settings → Community plugins** to load the new code.
- **Focus events need a focused window.** If you drive Obsidian from a terminal
  while its window is in the background, focus handlers never run. See
  `README-TESTING.md` for how to emulate focus.

If your change touches scrolling, touch input or layout, try it on a phone or
tablet too: desktop mobile emulation still runs Chromium. On a Mac,
`npm run deploy:ios` copies the test vault to Obsidian's iCloud folder.

## Code guidelines

- Write TypeScript against the public Obsidian API, and keep `tsconfig.json` on
  `strict`.
- Keep styling in `styles.css`, and use Obsidian's CSS variables so themes keep
  working. Avoid `:has()`; toggle a class from the code instead.
- Protect people's notes. Flush pending edits when a view closes, and handle vault
  writes, renames and files created at the same time without losing text.
- Obsidian's embedded Markdown editor is an internal API. Keep all access to it in
  `src/editor.ts`, guard against failures, and keep the plain-text fallback
  working.
- Match the style of the surrounding code.

[AGENTS.md](AGENTS.md) has a map of the source files and what each one does.

## Opening a pull request

1. Branch from the latest `dev`, for example `fix/empty-day-template` or
   `feature/weekly-summary`.
2. Keep each pull request to one change, so it can be reviewed and reverted on its
   own.
3. Run the same checks as CI:

   ```bash
   npm run typecheck
   npm run lint
   npm run build
   ```

   `npm run lint` fails on any warning, because Obsidian's plugin review raises
   the same ones.
4. If the change affects what users see or can configure, update
   [docs/guide.md](docs/guide.md), and the [README](README.md) if needed.
5. Open the pull request against **`dev`**, not `main`. Describe what changes for
   users, link the issue it addresses, and say what you tested and how. Include
   screenshots or a short recording for visible changes.

`main` only receives releases. Maintainers move `dev` into `main`, bump the
version and publish the release, so don't change version numbers in your pull
request.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
