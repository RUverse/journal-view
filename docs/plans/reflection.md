# Reflection: feature plan

Planned 2026-10-19, still in prototyping. This is a working plan for contributors, not user
documentation: once the feature lands, its behavior belongs in [the guide](../guide.md).

Reflection lets a local model read the journal and write back something worth reading: what you
learned over the last two weeks, what this date looked like in past years, plans that went quiet.
The reflection is saved as a note and shown on the day it was made, inside a bordered card that sets
it apart from what you wrote yourself.

The repository's [AGENTS.md](../../AGENTS.md) still applies: the work happens on the
`feature/reflection` branch and lands through its one pull request into `dev`. Run
`npm run typecheck`, `npm run lint` and `npm run build`, and verify in the test vault.

## Contents

- [Design drafts](#design-drafts)
- [Decisions](#decisions)
- [What the user sees](#what-the-user-sees)
- [Presets](#presets)
- [Architecture](#architecture)
- [Reflection files](#reflection-files)
- [Context and tools](#context-and-tools)
- [Order of work](#order-of-work)
- [Testing with Ollama on a Mac](#testing-with-ollama-on-a-mac)
- [Risks](#risks)
- [Defaults assumed](#defaults-assumed)

## Design drafts

The drafts are in the Penpot file *Journal View*, on the boards named *Reflections — …*. These crops
show the journal column of each:

| Resting | Hovered | Preset menu (sketch) | Generating | Ready |
| --- | --- | --- | --- | --- |
| ![Resting](reflection/1-resting.png) | ![Hovered](reflection/2-hovered.png) | ![Preset menu sketch](reflection/3-preset-menu-sketch.png) | ![Generating](reflection/4-generating.png) | ![Ready](reflection/5-ready.png) |

1. **Resting:** a faint pill below today's card.
2. **Hovered:** the pill grows into a **Reflect** button.
3. **Preset menu:** a rough sketch of a short list of presets (*this day over years*, *summarize*,
   *?*). The menu below replaces it.
4. **Generating:** a card with a thin border and no fill, titled **Reflection**, with skeleton lines.
5. **Ready:** the same card; its body is left empty in the draft.

## Decisions

Agreed with the user on 2026-10-19:

| Topic | Decision | Why |
| --- | --- | --- |
| Context | Presets fix their own range and the plugin hands those notes over. Custom prompts give the model tools; models without tools get a range picker | Presets must work with any model; small local models call tools unreliably |
| Storage | One Markdown note per reflection in a configurable `Reflections` folder | Searchable, linkable, and kept without the plugin; no lock-in |
| Composer | A menu of presets under the button; **Write your own…** and **Presets and model…** open a modal | One click for the common case, a full form for the rest |
| Card | Read-only Markdown with linked source dates, **Regenerate**, **Ask a follow-up**, and **Delete** | Lets the reader check a reflection against what they wrote and keep talking to it |
| Generating | The drafted skeleton until the first words arrive, then streamed text with **Stop** | A local model reading two weeks of notes can take 30 s or more |
| Newest first | The whole stack flips: button, reflections (newest first), then the day's card | A new reflection always appears next to the button that made it |
| Provider | Ollama only, behind a provider interface | Room for LM Studio or llama.cpp later without key storage now |
| Platform | Desktop only for now: hidden on mobile, `isDesktopOnly` stays `false` | Ollama usually runs on the same computer as Obsidian |

## What the user sees

### The button

- Today's day gets a handle: below its card when the journal runs oldest to newest, above it when it
  runs newest to oldest (`daySortDirection`, `src/settings.ts:15`).
- Hovering, or focusing it with the keyboard, expands it into **Reflect**. Focus is a real path, not
  only hover: it is a `<button>` with an accessible name.
- It follows the pattern of today's add-note button (`src/day.ts:115`), and only exists on desktop
  (`Platform.isDesktop`) while **Show Reflect button** is on.

### The menu

Selecting **Reflect** opens an Obsidian `Menu` under the button:

```text
This day over the years
What I learned · 14 days
Week in review · 7 days
Open loops · 30 days
Recurring themes · 90 days
Questions to sit with · 14 days
────────────
Write your own…
Presets and model…
```

- A preset item shows how much it would read, such as `90 days · ~12k words`, so a slow run is not a
  surprise.
- Until Ollama answers, the menu holds a single **Connect to Ollama…**, which opens the modal at its
  connection step.

### The modal

- **Connection:** server address (default `http://127.0.0.1:11434`), a status line, and setup steps
  when nothing answers (install Ollama, `ollama pull llama3.1:8b`, retry).
- **Model:** a dropdown of installed models (`/api/tags`), marking which support tools. The choice is
  remembered as the default and can be changed for a single run.
- **Prompt:** a text box, with the presets as chips above it that fill it in.
- **Scope:** *Let the model choose* (needs a model with tools), *Last 7 / 14 / 30 / 90 days*, *This
  day over the years*, or a custom from–to range. Without tool support, *Let the model choose* is
  disabled with a one-line explanation and the scope defaults to *Last 14 days*.
- **Presets:** save the current prompt and scope as a preset; edit, reorder and delete presets; reset
  the built-in ones.
- **Create** closes the modal and starts the card.

### The card

States, in order:

1. **Reading:** the card appears next to the button with the drafted skeleton and a status line:
   `Reading 5–19 Oct · 9 notes`, or each tool call as it happens (`Searching for "running"`).
2. **Writing:** the first words replace the skeleton and the text streams in. **Stop** keeps what has
   been written so far.
3. **Ready:** the reflection renders as Markdown, read-only.
   - Cited dates such as `[[2026-10-05]]` move the journal to that day instead of opening the file.
   - A footer reads `From 9 notes · 5–19 Oct` and expands into date chips that do the same.
   - Top right, matching a note's header buttons: **Regenerate** and **Delete**.
   - At the bottom, an **Ask a follow-up…** box continues the same conversation inside the card.
4. **Error:** Ollama stopped answering, the model is missing, or the notes did not fit. The card
   says what happened and offers **Retry**. Nothing is saved unless some text arrived.

The card is a box with a border and no fill, like the draft, so it never reads as a note. Generation
keeps running if the reader scrolls away or the day is unloaded; the card picks up the current text
when its day loads again.

## Presets

Each preset fixes the notes it reads, so it works with every model. The wording is a starting point,
to be tuned in the spike (step 0).

| Preset | Reads | Asks for |
| --- | --- | --- |
| This day over the years | This date in every earlier year | What you did, worried about and hoped for on this date, and what changed |
| What I learned | Last 14 days | Lessons and realizations, each with the date it came from |
| Week in review | Last 7 days | High and low points, energy, and one question to carry into next week |
| Open loops | Last 30 days | Plans and intentions ("I want to…", "try…") that never came up again |
| Recurring themes | Last 90 days | People, worries and topics that keep returning, and how they shifted |
| Questions to sit with | Last 14 days | Three questions, each tied to a specific entry, and no advice |

The shared system prompt is what separates an insight from a horoscope:

- Ground every point in specific entries and cite them with the exact link given for each note.
- When the notes do not cover something, say so instead of filling the gap.
- No praise, no generic advice, no therapy-speak.
- Write to the reader in the second person, in the language their notes are written in.
- Keep it to about 150–300 words unless the prompt asks otherwise.

## Architecture

A new `src/reflection/` module. The view only creates the button and the cards; everything else
stays behind small host interfaces, as with the view's other collaborators.

| File | Responsibility |
| --- | --- |
| `provider.ts` | The provider interface: list models, report tool support, stream a chat with tools, cancel |
| `ollama.ts` | Ollama implementation. `/api/tags` and `/api/show` go through `requestUrl`; `/api/chat` streams with `fetch` and falls back to a non-streaming `requestUrl` |
| `context.ts` | Reads notes for a range or for this date over the years, formats them, and budgets tokens |
| `tools.ts` | The tools offered to custom prompts, and the bounded tool loop |
| `presets.ts` | Built-in presets, and merging them with the user's |
| `store.ts` | Indexes the Reflections folder by date, follows vault events, creates, rewrites and trashes reflection files |
| `card.ts` | The bordered card: skeleton, streaming, Stop, Regenerate, follow-ups, sources, errors |
| `button.ts` | Today's handle and its preset menu |
| `modal.ts` | Connection, model, prompt, scope and preset management |

Changes to existing code:

- `src/settings.ts`: a `reflections` block holding the server address, default model, folder
  (default `Reflections`), maximum context size, **Show Reflect button**, and presets, plus a
  *Reflections* section in the settings tab.
- `src/day.ts`: a reflections element on every day, placed by sort direction, and the handle on
  today.
- `src/dayFiles.ts`: leave the Reflections folder out of file history, next to the template folders
  (`src/dayFiles.ts:229`).
- `src/main.ts`: create the store as a child component, like `FindCorpus`
  (`src/main.ts:101`), and add a **Create reflection** command that opens the menu's choices.
- `README.md`: a feature bullet and a revised **Privacy** section. It currently promises no network
  requests; it must say that reflections send the notes they read to the Ollama server you configure,
  by default on this computer, and nowhere else.
- `docs/guide.md`: a *Reflections* section, once the feature is usable.

Notes are matched by folder and date format (`src/noteIndex.ts:245`), so files in a separate
Reflections folder cannot be taken for daily notes. Keep the folder outside the daily-notes folder by
default, and refuse a Reflections folder equal to it.

## Reflection files

One file per reflection: `Reflections/2026-10-19 What I learned.md`, then `… What I learned 1.md`
for a second one the same day. Custom prompts are named from the prompt's first words.

```yaml
---
journal-view: reflection
created: 2026-10-19T15:32
preset: what-i-learned
prompt: Summarize what I learned during the last 2 weeks
model: llama3.1:8b
from: 2026-10-05
to: 2026-10-19
sources: ["[[2026-10-05]]", "[[2026-10-09]]", "[[2026-10-14]]"]
---
```

- The body is the reflection. Each follow-up is appended as a question callout followed by its
  answer, which renders well in Obsidian and can be read back into a conversation:

  ```markdown
  > [!question] Say more about the second point

  The answer…
  ```

- The day a reflection belongs to is the date in `created`.
- The file is written once the stream ends, or on **Stop** if some text arrived. Regenerate rewrites
  the body in place with `vault.process` once the new answer is complete, and asks first when there
  are follow-ups, which it clears.
- Delete reuses the note flow: `fileManager.promptForDeletion`, then `trashFile`
  (`src/entry.ts:1321`).

## Context and tools

- Each note is passed oldest first, without its YAML properties, under a heading that carries its
  exact link: `### [[2026-10-05]] · Monday, 5 October`. The model is told to cite with those links,
  so citations resolve whatever the date format is.
- The system message states today's date and the range being read.
- **Budget:** estimate tokens at about four characters each, then set Ollama's `options.num_ctx` to
  fit the prompt plus room for the answer, capped by the model's own limit and by the *Maximum
  context* setting. Without this, Ollama silently cuts prompts at its default context size.
- When the notes do not fit, drop whole notes evenly across the range rather than only the oldest,
  and say so on the card: `Read 20 of 31 notes; the rest did not fit`.

Tools offered to custom prompts on models that support them:

| Tool | Returns |
| --- | --- |
| `list_journal(from, to)` | Dates, note labels, word counts and tags: a cheap overview |
| `read_journal(from, to, tag?)` | The notes themselves, within the budget |
| `on_this_day(date?)` | This date in every earlier year |
| `search_journal(query, from?, to?)` | Matching days with short excerpts |

The loop stops after about six rounds and then asks for the answer. Each call shows in the card's
status line. Read note bodies through the existing `FindCorpus` or statistics reads where they fit,
rather than adding another cache.

## Order of work

All steps land on `feature/reflection`, one or more commits each, and reach `dev` together through
the feature's single pull request. Merge the latest `dev` into the branch when it falls behind. Keep
the build passing after every step, so the branch can be tested at any point.

### 0. Spike: judge the reflections before building the UI

The current test vault is filler (`word word word…`), useless for judging a reflection. Before any
UI:

1. Add a realistic sample journal to the test vault, dated relative to the day the script runs:
   about 90 days of short fictional entries before today, plus this date in each of the three
   previous years. Plant patterns to check the presets against:
   - a worry that recurs and slowly fades;
   - a habit started and then dropped;
   - two plans written once and never mentioned again;
   - one lesson stated plainly;
   - a person who comes up often.
2. Write a throwaway Node script that builds the context exactly as `context.ts` will and calls
   Ollama. Run every preset on two or three models and record, in this file:
   - whether it found the planted patterns;
   - whether its citations point at the right days;
   - how long it took.
3. Tune the presets and the system prompt until the results are worth reading.

The spike decides whether the presets are good, which the UI cannot fix later. Keep the sample
journal; the script can be dropped once `context.ts` exists.

### 1. Reflection files and cards

- The `store.ts` index and the card in its ready state, on the right day in both orders.
- **Delete**, and leaving the folder out of file history.
- No network yet: verify with reflection files written by hand.

### 2. Ollama provider and context

- `provider.ts`, `ollama.ts` with streaming and its fallback, and `context.ts` with budgeting.
- The settings section with a **Test connection** button.
- The README Privacy change, since this is the first network use.

### 3. Reflect button and presets

- The handle, the menu, and the built-in presets.
- The card's reading, writing, stopped and error states, and saving the file.

### 4. Modal and tools

- Custom prompts, the scope picker, `tools.ts` with its loop and fallback, and preset management.

### 5. Regenerate, follow-ups and sources

- Regenerate, the follow-up box and its callouts, the sources footer, and citations that move the
  journal.
- The guide section.

## Testing with Ollama on a Mac

```bash
ollama pull llama3.1:8b        # tools
ollama pull qwen3:8b           # tools
ollama pull gemma3:4b          # check `ollama show gemma3:4b`: if it lists no tools, it tests the fallback
curl http://127.0.0.1:11434/api/tags
```

Then, from Obsidian's developer console with the test vault open, check that Ollama accepts the app's
origin, which streaming depends on:

```js
await fetch("http://127.0.0.1:11434/api/tags").then((r) => r.json())
```

If that fails with a CORS error, allow the origin and restart Ollama:
`launchctl setenv OLLAMA_ORIGINS "app://obsidian.md*"`. The `requestUrl` fallback must still produce
a reflection, just without streaming, so test both.

Worth exercising for each step:

- Both day orders, and a reflection on a day without a note while **Only show days that have a note**
  is on.
- Scrolling while a card streams, in both orders. In newest-first mode the growing card sits above
  the reader, and the scroll anchor (`src/anchor.ts`) has to absorb that growth without the text
  jumping.
- Stop part-way, Regenerate with and without follow-ups, and Delete.
- Ollama quit mid-run, a model removed after it was chosen, and a 90-day preset on the smallest
  model.
- Disabling the plugin mid-run: the request is cancelled and nothing half-written is saved.

The traps in AGENTS.md apply: focus events need focus emulation when driven from the terminal, and
the plugin has to be disabled and re-enabled to load a new build.

## Risks

- **`fetch` in the review.** The Obsidian lint config warns on `fetch` and suggests `requestUrl`, which
  cannot stream. Use `fetch` only for the streaming chat call, in `ollama.ts`, with a scoped disable
  explaining why. Everything else uses `requestUrl`.
- **Ollama blocking requests from Obsidian.** Ollama allows `app://*` origins by default: checked on
  2026-10-19 with Ollama 0.40.6, where a `GET /api/tags` and a JSON `POST /api/chat` from the test
  vault both got through, preflight included. Other versions or a custom `OLLAMA_ORIGINS` may differ;
  the fallback keeps the feature working either way.
- **Tool calling.** Small models often skip tools or call them with bad arguments. Validate arguments,
  return clear errors the model can recover from, and fall back to the range picker when a model has
  no tool support.
- **Thinking models.** `qwen3`, and on the test Mac `qwen3.8` and `gemma4`, report the `thinking`
  capability and by default reason before answering, in a separate `message.thinking` field. That
  text must not stream into the card or be saved, and it uses up context. Send `think: false` for
  presets, or keep the thinking apart and show `Thinking…` in the status line; decide in the spike.
- **Speed.** On a machine without a GPU, a 90-day preset can take minutes. The menu shows the size
  up front, and Stop always works.
- **Scroll position.** Text streaming into a card above the reader (newest first) must not move what
  they are reading.

## Defaults assumed

Not yet confirmed with the user; change them here if they turn out wrong.

- Reflections read only notes the journal's filters let through, so an exclude rule such as `#private`
  keeps those notes from the model. The card notes when filters are on.
- A reflection keeps its day in the journal even with **Only show days that have a note** on.
- Regenerate replaces the first answer and clears follow-ups, asking first when there are some.
- **Find in journal** does not search reflections in the first version.
- **Show Reflect button** is on by default on desktop.
- The menu's presets use the default model; the modal can pick another for one run.
