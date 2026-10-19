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
  when nothing answers: install Ollama, pull a model, retry. Suggest `gemma4:26b` with 32 GB of memory
  or more and `gemma4:e4b` otherwise (see the spike's results).
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

Each preset fixes the notes it reads, so it works with every model. The spike (step 0) tuned the
wording; `PRESETS` in `scripts/reflection-spike.mjs` holds each preset's exact request and the shape
of its answer, and `presets.ts` should start from those.

| Preset | Reads | Asks for, in this shape |
| --- | --- | --- |
| This day over the years | This date in every earlier year, and today | A paragraph per note, starting with its link, then the first note's hopes set against today |
| What I learned | Last 14 days | One to three lessons as bullets, each in close to the note's own words, with its link |
| Week in review | Last 7 days | **High points** and **Low points** as cited bullets, **Energy** day by day, and one question |
| Open loops | The 30 days before today | Each plan once, under **Still open** (where it was written) or **Followed up** (where it was) |
| Recurring themes | Last 90 days | Three to five topics, each with its first and last mention, saying when one stopped appearing |
| Questions to sit with | Last 14 days | Three numbered questions, each after an entry's link and what it says, about what it leaves open |

Open loops ends yesterday because the models list today's to-dos however they are told not to; a plan
written today is not an open loop yet.

The shared system prompt is what separates an insight from a horoscope:

- Ground every point in specific entries and cite them with the exact link given for each note.
- When the notes do not cover something, say so instead of filling the gap.
- No praise, no generic advice, no therapy-speak.
- Write to the reader in the second person, in the language their notes are written in.
- Keep it to about 150–300 words unless the prompt asks otherwise.

Small models stop following the system prompt a few thousand tokens later, so the request ends with
a short reminder after the notes: write to me as "you", cite only with the links in the headings, one
date per link, use only what the notes say, and no praise, advice or closing summary. Without it, and
without the preset's answer shape, 8B models cited nothing at all.

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

- Each note is passed oldest first under a heading that carries its exact link:
  `### [[2026-10-05]] · Monday, 5 October`. The model is told to cite with those links, so citations
  resolve whatever the date format is.
- Below the heading goes one line of the note's properties, such as `mood: awful · tags: work`,
  leaving out empty values, values that every note in the range shares (`type: daily`, the tag
  `journal`), and values that restate the note's date. The YAML itself is not passed. Moods are the
  best signal *Week in review* has for energy, and stripping all properties lost them.
- The note's own headings are pushed below that `###`, so a `## Log` cannot read as a new note.
- The system message states today's date. The user message names the range, lists the notes, and
  ends with the preset's request, its answer shape, and the reminder.
- **Budget:** estimate tokens at about four characters each, then set Ollama's `options.num_ctx` to
  fit the prompt plus room for the answer, capped by the model's own limit and by the *Maximum
  context* setting. Without this, Ollama silently cuts prompts at its default context size. For
  English the estimate came within 5% of Ollama's count but ran low on Gemma, so add 10%. Scripts
  such as Persian or Chinese take more tokens per character; check the first response's
  `prompt_eval_count` against the estimate, and leave more room when they differ.
- When the notes do not fit, drop whole notes evenly across the range rather than only the oldest,
  and say so on the card: `Read 20 of 31 notes; the rest did not fit`.
- **Citations as written:** models sometimes put two dates in one link (`[[2024-10-19, 2025-10-19]]`)
  or write a bare `2026-10-05`. Before rendering, split such links into one per date, and link bare
  dates that match a note that was read. Leave dates that match no note as plain text.

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

Done on 2026-10-19: see [The sample journal](#the-sample-journal) and [Results](#results) below.

The test vault's notes were filler (`word word word…`), useless for judging a reflection. Before any
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

#### The sample journal

The journal is now the test vault's own `Journal/`. `scripts/sample-journal.md` holds 66 entries
keyed by "days ago" and "years ago": 63 between 89 days ago and today, with ordinary gaps and one
5-day gap (43–39, a visit to the parents), and this date 1, 2 and 3 years ago. `npm run test-vault`
writes them the first time, and `npm run sample-journal` moves them up to today. The setup script's
fixtures moved to May 2026, before those 90 days.

The narrator is a product designer living alone; Mina is their younger sister, Theo a coworker and
friend, Dana their manager. Planted patterns, by days ago:

| Pattern | Where | A good reflection |
| --- | --- | --- |
| Worry that fades: a reorganization at work | Heavy 86–60 (9 entries), lighter 57–35, last at 24 ("hadn't thought about it in over a week") | Names it, and says it faded once names were announced at 51 |
| Habit dropped: morning runs | First run 80, 5 km at 62, sore knee 50, "I should get back to it" 45, then nothing | Notices the runs stopped after 45 |
| Two plans never mentioned again | 27: write to Mr. Farahani, an old art teacher. 15: build a hallway bookshelf | *Open loops* lists both |
| Decoys that were followed up | Bike brakes 22 → fixed 17; helping Mina move 19 → done 9; client presentation 13 → held 5 | *Open loops* leaves them out |
| A lesson stated plainly | 6: walking away for twenty minutes beats two hours of forcing a design | *What I learned* finds it, cited to 6 |
| A lesson left implicit | 11: Mina calms down once the narrator stops offering solutions and listens | A strong answer finds it; not required |
| A person who comes up often | Mina in 17 entries: flat hunt from 65, lease at 30, move at 9, dinner at hers at 3 | *Recurring themes* names her and her move |
| Private entry | 33, tagged `private`: a doctor's visit for headaches; 20: mostly gone after less coffee | Reads only when filters let it through |
| The last week | 6 good, 5 a bad client presentation, 4 tired, 3 dinner at Mina's, 2 steady, 1 drained but a good book, 0 calm | *Week in review* gets the high (3) and low (5) |
| This day over the years | 3 years: just moved, lonely, wants friends and meaningful work. 2: new job, likes Theo, Mina visits. 1: Mina has moved to the city, rent going up. Today: settled, Mina 10 minutes away | Traces loneliness to closeness, citing each year |

#### Results

Run on 2026-10-19 on an M5 Max with 128 GB, Ollama 0.40.6, through `scripts/reflection-spike.mjs`.
The prompts went through four rounds. Separate grading agents read every answer against the notes
and the key above, checking each claim and whether each cited note supports the sentence it is
attached to, and scored it from 1 (wrong or generic) to 5 (grounded, specific, accurate). One sample
can move a score by about a point, so the last round used two samples per model.

| Model | Memory once loaded | Short presets, last round | *Open loops* and *Recurring themes* | Time per preset | Verdict |
| --- | --- | --- | --- | --- | --- |
| `gemma4:26b` | ~18 GB resident | 4.4 | Open loops 5 in both samples; Recurring themes 3 | 1–9 s | Suggest with 32 GB or more |
| `gemma4:12b` | 15 GB | 4.75 | Files one open plan as followed up; Recurring themes 2–4 | 1–11 s | Only with 24 GB or more; little gain over 26b's memory |
| `gemma4:e4b` | 10 GB | 3.25 | Open loops 2–3, or 4–5 with thinking (6–8 s); Recurring themes 2 | 1–5 s | Suggest with 16 GB |
| `qwen3:8b` | 6 GB | 2.75 | 1.5; usable on Open loops only with thinking (25–29 s) | 2–9 s | Not suggested |
| `llama3.1:8b` | — | 2.0 (third round) | 2.7 | 3–10 s | Not suggested |
| `gemma3:4b` | — | 1.75 | 1.3; writes fiction | 2–10 s | Not suggested |

Memory is macOS's `footprint` for the runner process, or its resident size for `gemma4:26b`, whose
weights are mapped from the file. `ollama ps` is unreliable here: it reported 16 GB for `gemma4:12b`
and 1.2 GB for `gemma4:26b`. `gemma4:26b` is a mixture of experts with under 4B parameters active per
token, which is why it is as fast as the 8B models. Expect every time to be several times longer on
a machine without Apple Silicon or a GPU.

By preset, with the final wording:

- **This day over the years:** 4–5 on the Gemma 4 models once each paragraph kept to its own year.
  Smaller models still misread who was where, such as Mina's "you could live here".
- **What I learned:** both lessons, the stated and the implicit one, in every sample from
  `gemma4:12b` and `gemma4:26b`. Asking for "one to three bullets and nothing else" stopped the
  padding that "up to five" invited.
- **Week in review:** 4.4 on average. The mood line under each heading fixed the energy arc, which
  the models had misdated while properties were stripped.
- **Open loops:** ending the range yesterday removed today's to-dos, which no instruction did. The
  **Still open** / **Followed up** shape gave follow-ups somewhere to go; putting **Followed up**
  first backfired, filing open plans there as "None". The final wording, with **Still open** first
  and each plan under one heading, was checked by hand in two samples per Gemma 4 model rather than
  graded: right every time on `gemma4:26b`, while `gemma4:12b` and `gemma4:e4b` still filed the
  bookshelf under **Followed up** unless `gemma4:e4b` was thinking.
- **Recurring themes:** the weakest preset, 3 at best. Models read a walk on 13 October as the runs
  resuming, and rarely say a worry faded. Writing the cut-off date into the prompt helped a little,
  since models cannot count back from today. The two-pass digest scored no better for any model at
  five times the time, because its first pass dropped details such as the worry's last mention; it
  is not planned.
- **Questions to sit with:** quoting the entry before the question made models drop the question or
  ask about minor lines, so the final wording keeps the summary sentence first. It was checked by
  hand rather than graded.

What carries into the implementation:

- The answer shape and the reminder after the notes are what made small models cite at all; without
  them, 8B models cited nothing in most answers. Keep both in `presets.ts`.
- Enforce in code what the models ignore: the range that ends yesterday, the cut-off date written in.
- Temperature made no difference worth keeping; leave each model's default.
- Thinking stays off (see [Risks](#risks)). If `gemma4:e4b` turns out to be what most people run,
  thinking for *Open loops* alone is worth another look: 6–8 s there, and it fixed the misfiled plan.
- The first round changed the prompt wording as well as adding the answer shapes, so its gains are
  not the shapes' alone.

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
ollama pull gemma4:e4b         # the suggestion for 16 GB; tools and thinking
ollama pull gemma4:26b         # the suggestion for 32 GB or more
ollama pull gemma3:4b          # no tools: tests the range-picker fallback
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
- **Thinking models.** `qwen3` and `gemma4` report the `thinking` capability and by default reason
  before answering, in a separate `message.thinking` field. Decided in the spike: send `think: false`
  for presets. Thinking helped only *Open loops*, and only on the smaller models, at 5–25 s extra;
  on `gemma4:26b` and `gemma4:12b` it added 70–115 s, and once the prompt and 4,643 tokens of
  reasoning added up to exactly the 8,192 of `num_ctx`, and no answer came. Models without thinking accept
  `think: false` too. If thinking is ever offered, never stream or save `message.thinking`, give it
  its own room in `num_ctx`, and treat an empty answer that stopped on `length` as an error.
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
