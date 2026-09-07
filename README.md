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
- **Focus the timeline.** Filter daily notes by tags or exact property values, with include and
  exclude rules that also carry through to calendar navigation and journal search.
- **Stay responsive across years of notes.** Journal View keeps the days around you ready to edit
  while efficiently handling the rest of your timeline.

## Settings

Journal View uses your existing daily-note configuration by default. You can override the date
format, folder, and template in **Settings → Journal View** without changing how the rest of your
vault handles daily notes.

Some Customization is only visible in the customization menu accessible from the view's toolbar.

| Setting | Default | What it does |
| --- | --- | --- |
| Date format / Folder / Template | Inherited | Overrides your vault's daily-note settings for Journal View |
| Day order | Oldest to newest | Reverses the complete timeline when set to newest to oldest |
| Daily header format | `dddd, D MMMM` | Controls how each daily header displays its date |
| Daily header style | Subtle | Shows each date subtly, as an H1, or hides the date display |
| Group days by year | On | Marks year boundaries between consecutive visible daily entries |
| Group days by month | Off | Groups daily entries beneath compact month and year headings |
| Focus today on open | On | Opens the journal at today's note and places the cursor there |
| Open journal on startup | Off | Opens or reveals Journal View after Obsidian restores the workspace |
| Only show days that have a note | On | Skips empty days while always keeping today visible; turn it off to show every day |
| Rich editor | On | Uses Obsidian's Markdown editor; turn it off to use the plain-text fallback |
| Autosave delay | 2000 ms | Sets how long Journal View waits after typing before saving |
| Days kept loaded | 60 | Sets the target number of days kept in the timeline; dropped days reload when you scroll back to them |

## Filters

Select the funnel button in the journal toolbar to open the filters. **Show only days with notes** is
enabled by default; Today remains visible even when it is empty or does not match the metadata
filters. Turn that option off to keep empty days available for writing while still hiding existing
notes that do not match.

Tag filters use tags from both frontmatter and note content. A parent tag also matches its nested
tags, so `#project` matches `#project/client`. Property filters compare exact string, number, or
boolean values, and a list property matches when one of its items equals the configured value.

Every include filter must match. A note matching any exclude filter is hidden, even if it satisfies
all includes. The funnel uses the accent color whenever a tag or property filter is active; the
note-only toggle does not highlight it. Filtered dates are disabled in **Go to date**, and **Find in
journal** searches only the notes currently included.

## Statistics

Choose **Statistics** in the journal pane's top-right **More options** menu, or
run **Journal View: Statistics** from the command palette. A separate tab shows
the current year as a mosaic of daily notes. Use the arrows or enter a year to
explore another year; **This year** returns to the current one.

Each square represents one day. Missing notes are empty, and existing notes with
zero words have an outline. The four color levels represent **1–299**, **300–799**,
**800–1,999**, and **2,000+** words. Hover or select a day to see its date and count,
then choose **Open in journal** to visit an existing entry. Arrow keys move between
days; Home and End move to the first and last day of the year. Narrow panes scroll
horizontally to keep the tiles readable.

Statistics include all daily notes from your configured folder and date format,
regardless of journal filters. Counts use the saved Markdown body, excluding YAML
properties: each whitespace-separated token containing a letter or number counts
as a word. Headings, code, links, and template text can contribute; embedded notes
are not expanded. Languages without spaces are not segmented into individual
words. The colors show the note's current length, not words written on that date.
Changes appear after the note is saved.

Only existing notes in the selected year are read, with two reads at a time and
progressive updates. A bounded memory cache keeps counts for recently visited
years; closing Obsidian clears it. Missing notes, counts still loading, and read
failures have distinct appearances. Large individual notes may take longer to
count, but counting yields periodically so year navigation remains available.

## Startup

Journal View is a custom view, so the Homepage plugin cannot select it as a homepage note. Enable
**Open journal on startup** in Journal View instead. If you also use Homepage, configure only one of
the two plugins to open content at startup so they do not compete for the active tab.

## Date commands

- **Go to today** opens the journal when needed, then focuses today's entry.
- **Go to yesterday** opens or reveals the journal, then focuses yesterday's entry.
- **Go to tomorrow** opens or reveals the journal, then focuses tomorrow's entry.

Yesterday and tomorrow are shown while focused even when the note-only toggle or a metadata filter
would normally hide them. All three commands scroll when the target is nearby and snap when it is
more than two view heights away.

## Privacy

Journal View works locally with files in your Obsidian vault. It does not make network requests,
collect telemetry, require an account, or access files outside your vault.

## License

[MIT](LICENSE) © 2026 RUverse
