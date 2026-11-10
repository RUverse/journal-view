# How Reflection works

A picture of what happens between asking a question and reading the answer. For how to use
Reflection, see [the guide](guide.md#reflections); for why it is built this way, see
[the plan](plans/reflection.md).

Everything below runs on your own computer. The two models are served by Ollama, and nothing else
is contacted.

## The parts

```mermaid
flowchart TD
    you(["You ask a question<br/>or pick a preset"])
    plugin["Journal View<br/>passes the question on,<br/>runs the tools the model asks for,<br/>and hands back what they found"]
    llm{{"Chat model, in Ollama<br/>decides what to look for,<br/>reads the notes,<br/>writes the answer"}}
    tools["Tools<br/>search · read chosen notes ·<br/>read a range of days ·<br/>list a period · a date over the years"]
    words["Search by words<br/>finds a word in any of its forms<br/>and ranks the notes that use it"]
    meaning["Search by meaning<br/>finds notes about the same<br/>thing in other words"]
    notes[("Your daily notes<br/>only those your<br/>filters allow")]
    embedder{{"Embedding model, in Ollama<br/>turns text into numbers that are<br/>close when the meaning is close"}}
    index[("Index file<br/>the numbers<br/>of every note")]
    answer(["The answer is saved as a note and<br/>shown on its day, with links to<br/>the notes it drew on"])

    you --> plugin
    plugin <-- "the question and what the tools found,<br/>for a tool to run or the answer" --> llm
    plugin --> tools
    tools --> words
    tools -.-> meaning
    words --> notes
    tools -- "notes in full" --> notes
    notes -. "new and changed notes" .-> embedder
    embedder -.-> index
    index -.-> meaning
    plugin --> answer
```

Solid lines are always there. Dotted lines are search by meaning, which is off until you turn it
on in the Reflect window's settings. The two six-sided boxes are the models; everything else is
the plugin and your files.

## One question, step by step

```mermaid
sequenceDiagram
    actor You
    participant P as Journal View
    participant M as Chat model
    participant J as Your notes

    You->>P: When did I stop running, and why?
    P->>M: The question, the tools, and today's date
    M->>P: Search for "running"
    P->>J: Find the notes that mention it
    Note over P,J: With search by meaning on, also the notes<br/>that are about it in other words
    J-->>P: The notes that match, best first
    P->>M: What was found: whole notes when they are few,<br/>excerpts when they are many
    M->>P: Read these three notes in full
    P->>J: Read them
    J-->>P: Their text
    P->>M: The notes, each with the link to cite it by
    M->>P: The answer, citing the notes it used
    P->>You: A reflection on today's page
```

The model may ask for several tools before it answers, and it stops after a few rounds. The plugin
does not let it answer before it has looked, or from excerpts alone.

## What each part is for

| Part | What it does |
| --- | --- |
| **Chat model** | The one that thinks: it decides what to look for, reads what comes back, and writes the answer. It never sees your whole journal, only what the tools return |
| **Tools** | The only way the model can see your notes. Each one returns a small, chosen part of the journal |
| **Search by words** | Finds a word in any of its forms (`run` finds `running`), ranks the notes, and shows the sentences around each match. When a subject's mentions fall within a short stretch of days, it returns that whole stretch, since what happened is often in a note that never names it |
| **Search by meaning** | Optional. Finds notes that are about what was asked without using its words: a search for exercise finds the days you went running. What it finds is shown to the chat model as candidates to judge, never as fact |
| **Embedding model** | Optional, and much smaller than the chat model. It turns a piece of text into a list of numbers, so two texts can be compared by how close their numbers are. It does not write anything |
| **Index file** | The numbers of every note, kept in the plugin's folder so each note is read by the embedding model once, and again only when it changes |
| **Your filters** | Decide which notes any of this can reach. A note a filter hides is never searched, read, or indexed |
