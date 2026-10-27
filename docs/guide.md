# Journal View guide

How Journal View works in detail. For an overview, see the [README](../README.md).

- [Navigation](#navigation)
- [Settings](#settings)
- [Several notes a day](#several-notes-a-day)
- [File modification history](#file-modification-history)
- [Filters](#filters)
- [Reflections](#reflections)
- [Statistics](#statistics)

## Navigation

- Select the calendar button in the journal toolbar to **Go to date**.
- Choose **Random entry** in the journal pane's top-right **More options** menu to jump to a random
  past day.
- Select the notebook button on an open daily note to show that day in the journal.

Three commands move to a nearby day:

- **Go to today** opens the journal when needed, then focuses today's entry.
- **Go to yesterday** opens or reveals the journal, then focuses yesterday's entry.
- **Go to tomorrow** opens or reveals the journal, then focuses tomorrow's entry.

Yesterday and tomorrow are shown while focused even when the note-only toggle or a metadata filter
would normally hide them. All three commands scroll when the target is nearby and snap when it is
more than two view heights away.

## Settings

Journal View uses your existing daily-note configuration by default. You can override the date
format, folder, and template in **Settings → Journal View** without changing how the rest of your
vault handles daily notes.

Some options are only available in the customization menu, opened from the journal toolbar.

| Setting | Default | What it does |
| --- | --- | --- |
| Date format / Folder / Template | Inherited | Overrides your vault's daily-note settings for Journal View |
| Multiple notes per day | Off | Shows notes with more after the date under that day, and adds a button to today that adds another note; see [Several notes a day](#several-notes-a-day) |
| Day order | Oldest to newest | Reverses the complete timeline when set to newest to oldest |
| Daily header format | `dddd, D MMMM` | Controls how each daily header displays its date |
| Daily header style | Subtle | Shows each date subtly, as an H1, or hides the date display |
| Group days by year | On | Marks year boundaries between consecutive visible daily entries |
| Group days by month | Off | Groups daily entries beneath compact month and year headings |
| Year progress | Left | Shows twelve month lines beside the journal that mark the month you are reading, like a scrollbar for the year, running in the same direction as the days; select a month to go to its first note. Choose left, right, hidden, or experimental, which puts them on the left with every month named. Appears only when the pane is at least 120 px wider than the journal |
| Focus today on open | On | Opens the journal at today's note and places the cursor there |
| Open journal on startup | Off | Opens or reveals Journal View after Obsidian restores the workspace. The Homepage plugin cannot select Journal View, so use this instead; if you use both, let only one of them open content at startup |
| Only show days that have a note | On | Skips empty days while always keeping today visible; turn it off to show every day |
| Show file modification history | Off | Lists the files created or last edited on each day at the bottom of the day; see [File modification history](#file-modification-history) |
| Rich editor | On | Uses Obsidian's Markdown editor; turn it off to use the plain-text fallback |
| Autosave delay | 2000 ms | Sets how long Journal View waits after typing before saving |
| Days kept loaded | 60 | Sets the target number of days kept in the timeline; dropped days reload when you scroll back to them |
| Reflections | On | Shows the Reflect button under today on desktop, the **Create reflection** command, and the reflections on each day; see [Reflections](#reflections) |

## Several notes a day

A day can hold more than one note in two ways, and Journal View shows all of them under that day:

- **Text after the date.** Turn on **Multiple notes per day** to also include notes whose names go
  on after the date, such as `2026-08-16 Birthday`. The text has to be set off from the date by a
  space or punctuation. Once today has a note, the bottom right of its card has an **Add a note to
  today** button that creates a note named after the date and the current time, such as
  `2026-08-16 14-30`, and puts the cursor in it. A second note in the same minute becomes
  `2026-08-16 14-30-1`, then `-2`, and so on. Select the text after a note's date, in the day's
  header or above the note, to rename the note: `14-30` can become `Lunch`, and links to the note
  follow. Writing in an empty day still creates the plain dated note.
- **A time in the name.** A format that records a time, for example `YYYY-MM-DD HHmm`, keeps a
  separate note for each moment. Writing in an empty day creates a note named after the current time.
  With **Multiple notes per day** on, the add button names its note the same way.

Notes are ordered by their time, then by name, with the plain-date note first. The first note sits
directly under the day's header, which shows its time or the text after its date; each further note
gets a divider with its own label and its own open and delete buttons.

## File modification history

Turn on **File modification history** in the customization menu, or **Show file modification history** in
**Settings → Journal View**, to list the other files from each day at the bottom of that day. The
list starts folded into one line, such as `3 files created · 2 last edited`; select it to see the files.

- Select a file to open it, or Ctrl/Cmd-select it to open it in a new tab.
- Hold Ctrl/Cmd while hovering a file to preview it. **Page preview** settings list it as
  *Journal files*, where the preview can be set to appear without the key.
- Right-click a file for Obsidian's file menu, where you can move or delete it.

Notes, canvases, and bases are listed. Daily notes, templates, and files matched by Obsidian's
**Excluded files** setting are always left out.

| Setting | Default | What it does |
| --- | --- | --- |
| Date | Created | Lists a file on the day it was created, on the day it was last edited, or on both |
| Created date property | Empty | Reads a note's created date from this property, such as `created`, instead of the file's own date |
| Include attachments | Off | Also lists images, PDFs, and other files |
| Excluded folders | Empty | Leaves out the files in these folders, separated by commas |

A file only keeps the date it was last edited, so **Last edited** moves it to the latest day it
changed. File dates can also be reset when a vault is synced, copied, or checked out with git; a
**Created date property** keeps notes on the day they were written.

With **Only show days that have a note** on, file history does not make a day without a daily note
appear in the journal or become selectable in **Go to date**. Today and the explicit date-command
exceptions still apply. Turn note-only filtering off to browse empty days; days with file history
then carry a hollow dot in **Go to date**. A day whose note is hidden by the filters stays hidden
whatever files it has.

File history sits below the note card, outside today’s highlighted background.

## Filters

Select the funnel button in the journal toolbar to open the filters. **Show only days with notes** is
enabled by default; Today remains visible even when it is empty or does not match the metadata
filters. Turn that option off to keep empty days available for writing while still hiding existing
notes that do not match.

Tag filters use tags from both frontmatter and note content. A parent tag also matches its nested
tags, so `#project` matches `#project/client`. Property filters compare exact string, number, or
boolean values, and a list property matches when one of its items equals the configured value.

Every include filter must match. A note matching any exclude filter is hidden, even if it satisfies
all includes. On a day with several notes, the day appears when any of them matches, and the notes
that do not match are hidden within it. The funnel uses the accent color whenever a tag or property filter is active; the
note-only toggle does not highlight it. Filtered dates are disabled in **Go to date**, **Random entry** picks
only from the notes currently included, and **Find in journal** searches only those notes.

## Reflections

On desktop, a model running on your own computer can read your journal and write back what it
notices: what you learned over the last two weeks, what this date looked like in past years, or the
answer to a question of your own. Each reflection is saved as a note and shown on the day it was
made, in a bordered box that sets it apart from what you wrote.

Reflections run through [Ollama](https://ollama.com). Install it, start it, and pull a model:
`gemma4:26b` with 32 GB of memory or more, or `gemma4:e4b` with 16 GB. Until Ollama answers, the
Reflect window shows these steps.

### Asking

Hover just below today's note (above it when the journal runs newest to oldest) and select
**Reflect**, or run **Journal View: Create reflection**. The Reflect window opens:

- Type a question and press Enter, or select **Reflect**. Shift+Enter starts a new line. What you
  typed is kept while Obsidian runs, so closing the window by accident loses nothing.
- Choose what the question reads, and the model. The line below says how much that is, such as
  `Reads 12 notes · ~3k words`.
- Select a preset to run it at once. Each shows how much it reads, so a slow run is no surprise. The
  bookmark button saves the question you typed, and what it reads, as a new preset.

| Reads | What the model is given |
| --- | --- |
| Let the model choose | The model searches, lists and reads your notes itself, which takes longer. It needs a model that can use tools; any other reads the last 14 days instead, and says so |
| Last 7, 14, 30 or 90 days | The notes from those days, today included |
| This day over the years | This date in every earlier year, and today |
| Dates… | The notes between two dates |

A reflection reads only the notes the journal's [filters](#filters) let through, so a rule such as
excluding `#private` keeps those notes from the model. When the notes do not fit the model's
context, whole notes are left out evenly across the range, and the reflection says how many it
reads while it reads them.

### Reading a reflection

The reflection appears next to the Reflect button with a line saying what it reads, or what the
model is looking up, then the answer as it is written. **Stop** keeps what has been written so far.
If something goes wrong, the box says what happened and offers **Try again**; nothing is saved
unless some text arrived.

- Select a date the reflection cites to move the journal to that day. Ctrl/Cmd-select it to open
  the note in a new tab.
- The line at the bottom, such as `From 9 notes · 5–19 Oct · gemma4:26b`, opens into the dates the
  reflection read; select one to move the journal there.
- **Ask a follow-up…** at the bottom continues the conversation. The answer is added to the
  reflection's note under the question, as a `[!question]` callout. A follow-up reads the same notes
  as the reflection; when the model chose its own, it looks through the journal again.
- **Regenerate**, at the top right, asks the same question again over the same notes, as of the day
  the reflection was made, and replaces the answer once the new one is complete. **Stop** keeps the
  old answer. When the reflection has follow-ups, you are asked first, since they are cleared.
- **Delete** moves the reflection's note to the trash, as deleting a note does.

A reflection keeps being written while you scroll away, and its box picks up where it is when you
come back.

### Reflection notes

Reflections are saved in the **Reflections** folder, named after their day and question, such as
`2026-10-19 What I learned.md`. Their properties record how they were made: `journal-view:
reflection`, when they were `created` (which sets their day), the `title`, `prompt` and `preset`,
what they read (`scope`, `from`, `to`), the `model`, and the `sources` they read, as links. They
are ordinary notes: you can open, link, search, and edit them, and the box shows the note's current
text.

A day with reflections stays in the journal even when it has no note and **Only show days that have
a note** is on. Reflection notes are never listed in [file history](#file-modification-history), and
**Find in journal** does not search them.

### Reflection settings

Select the gear in the Reflect window for its settings. **Settings → Journal View** keeps only the
**Reflections** toggle, which turns the whole feature off.

| Setting | Default | What it does |
| --- | --- | --- |
| Server | `http://127.0.0.1:11434` | Where Ollama answers. The notes a reflection reads are sent there, and nowhere else |
| Model | The first installed | The model reflections use; choosing one in the Reflect window changes it too. Models that cannot use tools are marked |
| Folder | `Reflections` | Where reflection notes are saved. It cannot be the daily-note folder |
| Maximum context | 32,768 tokens | The most a reflection asks the model to hold. More reads more notes at once but uses more memory; *Let the model choose* asks for all of it |
| Presets | Six built in | Reorder, edit, delete, or add presets. **Restore built-in presets** brings back the built-in ones you edited or deleted, and keeps your own |

On a computer without a capable GPU, a 90-day preset can take minutes.

## Statistics

Choose **Statistics** in the journal pane's top-right **More options** menu, or
run **Journal View: Statistics** from the command palette. A separate tab shows
the current year as a mosaic of daily notes. Use the arrows or enter a year to
explore another year; **This year** returns to the current one.

Each square represents one day. Missing notes are empty, and existing notes with
zero words have an outline. A day with several notes counts all of them together. The four color levels represent **1–149**, **150–399**,
**400–999**, and **1,000+** words. Hover or select a day to see its date and count,
then choose **Open in journal** to visit an existing entry. Arrow keys move between
days; Home and End move to the first and last day shown. A pane too narrow for the
whole year leaves out its earliest weeks, so the tiles keep their size without
scrolling.

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

### New words

Below the year, **New words** shows the whole journal as one column of twelve
months per year, so, as in the year mosaic, later is always down or to the right. It runs
through the current year, and a journal younger than 24 years is padded with
empty years before it, so the mosaic matches the width of the year above. A
pane too narrow for every year leaves out the earliest ones. Each month is colored by how many words appeared in your journal for the
first time in it, judged by note date, so a note added later for an earlier day
counts toward that day's month. Colors rank the months that added words into four
quarters, because the first months of a journal add far more words than the rest.
Each quarter's boundary is rounded to a round number, such as 80, 100, or 200,
and the legend shows the resulting ranges. Hover or select a month to see its new words and
the size of your vocabulary so far; up and down move by month, left and right by
year.

Once the whole journal has been read, selecting a month lists its new words, most
used first or alphabetically. Choose a word to open the note that first used it.

Words are counted once each, ignoring case and accents typed in different forms.
YAML properties, code (fenced, indented, inline, and inside quotes), comments,
links of every kind (including their text, reference links, and their
definitions), footnote markers, URLs, anything with an @ such as email addresses,
tags, HTML tags, callout types, and block IDs are left out, as are numbers
without a letter. Words joined by an apostrophe or a
zero-width non-joiner stay whole; hyphenated words count as their parts.

English forms of a word count as one word: plurals, possessives, and *-ed* and
*-ing* forms, so *portraits*, *portrait's*, and *portrait* are the same word, as
are *walk*, *walked*, and *walking*, and *dance*, *danced*, and *dancing*. A word is listed in the form it was first
written, and hovering it shows its other forms. Irregular forms such as *made*,
and words built on another, such as *happiness*, stay separate. Words in other
scripts, or with accents, are not reduced.

This reads every daily note, two at a time, the first time you open
**Statistics** in a session; the months fill in from the earliest one. Later edits
re-read only the changed note. The words are kept in memory until Obsidian closes,
and reading them also counts each note, so every year's mosaic opens instantly.
