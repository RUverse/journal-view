# Journal View

Give your daily notes a sense of continuity. Journal View brings them together in one scrollable,
editable timeline, so revisiting the past and writing today feel like part of the same story.

<p align="center">
  <img src="assets/journal-view.png" alt="Journal View open in Obsidian">
</p>

Open Journal View from the sidebar or run **Open journal** from the command palette.

- **Use the daily notes you already have.** Journal View works with your existing notes and daily-note
  settings—no plugin-specific formats, duplicate files, or lock-in.
- **Navigate through time with ease.** Scroll through your journal, jump to any date with the calendar,
  return to today in one click, or open the surrounding days from the notebook button on a daily note.
- **Edit directly in the timeline.** Read and write without switching between files, views, or editing
  modes.
- **Write only when there is something to say.** Start typing on an empty day and Journal View creates
  the daily note only when you need it.
- **Rediscover past entries.** Search across your journal to quickly find notes, ideas, and memories
  from any day.
- **Stay responsive across years of notes.** Journal View keeps the days around you ready to edit
  while efficiently handling the rest of your timeline.

## Settings

Journal View uses your existing daily-note configuration by default. You can override the date
format, folder, and template in **Settings → Journal View** without changing how the rest of your
vault handles daily notes.

| Setting | Default | What it does |
| --- | --- | --- |
| Date format / Folder / Template | Inherited | Overrides your vault's daily-note settings for Journal View |
| Day order | Oldest to newest | Reverses the complete timeline when set to newest to oldest |
| Daily header format | `dddd, D MMMM` | Controls how each daily header displays its date |
| Daily heading style | Journal View default | Can use the current theme's H1 typography for daily headings |
| Open note control | Show button | Can hide the open-note button or replace it with a clickable daily heading |
| Hide header separator | Off | Removes the line between each daily heading and its note contents |
| Group days by year | On | Marks year boundaries between consecutive visible daily entries |
| Group days by month | Off | Groups daily entries beneath compact month and year headings |
| Focus today on open | On | Opens the journal at today's note and places the cursor there |
| Open journal on startup | Off | Opens or reveals Journal View after Obsidian restores the workspace |
| Only show days that have a note | On | Skips empty days while always keeping today visible; turn it off to show every day |
| Hide note H1 heading | Off | Hides a leading H1 in the journal while keeping it in the daily note file |
| Rich editor | On | Uses Obsidian's Markdown editor; turn it off to use the plain-text fallback |
| Autosave delay | 2000 ms | Sets how long Journal View waits after typing before saving |
| Days kept loaded | 60 | Sets the target number of days kept in the timeline; dropped days reload when you scroll back to them |

## Date commands

- **Go to today** opens the journal when needed, then focuses today's entry.
- **Go to yesterday** focuses yesterday or the closest earlier daily note.
- **Go to tomorrow** focuses tomorrow or the closest later daily note.

All three commands scroll when the target is nearby and snap when it is more than two view heights away.

## Startup

Journal View is a custom view, so the Homepage plugin cannot select it as a homepage note. Enable
**Open journal on startup** in Journal View instead. If you also use Homepage, configure only one of
the two plugins to open content at startup so they do not compete for the active tab.

## Privacy

Journal View works locally with files in your Obsidian vault. It does not make network requests,
collect telemetry, require an account, or access files outside your vault.

## License

[MIT](LICENSE) © 2026 RUverse
