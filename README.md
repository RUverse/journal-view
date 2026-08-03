# Journal View

An Obsidian plugin that adds a **Journal** view — a first-class view like Graph or Canvas, but for
your daily notes.

Every day is stacked vertically in one continuous, editable page. Today sits in the centre when the
view opens, past days run upwards, future days run downwards. Days that do not have a note yet are
shown faded; the moment you type in one, the file is created.

## What it does

- **One view, every day.** Opens from the ribbon (`Open journal`) or the command palette.
- **Today is the anchor.** The view scrolls today into the centre on open and puts the cursor there.
  The toolbar button (and the `Go to today` command) brings you back.
- **Infinite in both directions.** Scroll up for older days, down for future ones. More days are
  appended a batch at a time as you approach either end.
- **Only a window of days is live.** The view keeps a bounded window of rendered previews and drops
  days far from the viewport. Only the day being edited has a live editor, so long journal sessions
  stay responsive without keeping an editor open for every note.

## Where the days come from

Journal View follows your vault's daily-note configuration, in this order:

1. Journal View's own overrides (Settings → Journal View)
2. **Periodic Notes**, if it has daily notes enabled
3. the core **Daily notes** plugin
4. `YYYY-MM-DD.md` in the vault root

So a day's file is just `<folder>/<date formatted>.md`; nothing extra is stored anywhere.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Date format / Folder / Template | inherited | Override the vault's daily-note settings for this view only |
| Header date format | `dddd, D MMMM YYYY` | How the date above each day reads |
| Focus today on open | on | Put the cursor in today's note when the view opens |
| Only show days that have a note | on | Skip empty days entirely; today is always shown. Off shows every day, faded until you type |
| Rich editor | on | Use Obsidian's markdown editor per day; off falls back to a plain text editor |
| Autosave delay | 600ms | Inactivity before an edited day is written to disk |

## Install (manual)

```bash
npm install
npm run build
```

Then copy `main.js`, `manifest.json` and `styles.css` into
`<your vault>/.obsidian/plugins/journal-view/` and enable **Journal View** in Settings → Community plugins.

For development, `npm run dev` rebuilds on change — point it at a vault by symlinking the plugin
folder.

## Notes on internals

Days are rendered as static Markdown previews until you edit them; this keeps their layout stable
while scrolling. Obsidian does not export an embeddable Markdown editor, so the optional rich editor
uses the app's internal embed registry. That integration is isolated and guarded: if an Obsidian
update changes it, Journal View falls back to a plain-text editor. Disable `Rich editor` to use the
public-API-only fallback directly.

## License

[MIT](LICENSE) © 2026 RUverse
