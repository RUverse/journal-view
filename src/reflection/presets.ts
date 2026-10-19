/**
 * The built-in reflections. Each fixes the notes it reads, so it works with
 * any model, and asks for its answer in a fixed shape with a place for each
 * citation: without one, small models cite nothing. The wording was tuned
 * against local models in the spike recorded in docs/plans/reflection.md;
 * change it there first.
 */

/** The notes a preset reads, counted back from today. */
export type ReflectionScope =
	| {
			kind: "days";
			/** How many days, today included unless the range ends before today. */
			days: number;
			/** Ends yesterday: today's plans are not open loops yet. */
			beforeToday?: boolean;
	  }
	| { kind: "this-day" };

export interface ReflectionPreset {
	id: string;
	name: string;
	scope: ReflectionScope;
	/** What the reader asks. */
	prompt: string;
	/**
	 * The shape of the answer. `{twoWeeksAgo}` becomes that date, written out,
	 * since models cannot count back from today.
	 */
	format: string;
}

/**
 * Sent first. `{exampleLink}` becomes the link of a note that is read, so the
 * example matches the vault's own date format.
 */
export const SYSTEM_PROMPT = `You read someone's private journal and write a short reflection back to them.

- Ground every point in specific entries, and cite each one with the exact link shown in its heading, such as {exampleLink}.
- When the notes do not cover something, say so instead of filling the gap.
- No praise, no generic advice, no therapy-speak.
- Write to the reader in the second person, in the language their notes are written in.
- Keep it to about 150–300 words unless the request asks otherwise.`;

/** Repeated after the notes, where small models still attend to it. */
export const REMINDER =
	'Write to me as "you". Cite only with the links exactly as written in the headings above, such as {exampleLink}, one note per link. Use only what the notes say. No praise, no advice, no closing summary.';

export const BUILT_IN_PRESETS: readonly ReflectionPreset[] = [
	{
		id: "this-day",
		name: "This day over the years",
		scope: { kind: "this-day" },
		prompt:
			"These are my notes from this date in earlier years, and from today. What was I doing, worrying about and hoping for on this date each year, and what has changed since?",
		format:
			"Write one short paragraph per note, oldest first, starting with the note's link alone. Keep each paragraph to its own year: who was around me and how near they were, what I worried about, and what I hoped for. Save every comparison for two or three closing sentences that set the first note's hopes against today's note.",
	},
	{
		id: "what-i-learned",
		name: "What I learned",
		scope: { kind: "days", days: 14 },
		prompt: "What did I learn or realize over these two weeks?",
		format:
			'Answer with one to three bullets and nothing else. Each is the lesson, said to me as "you", then the link of the note it comes from. A note counts when it states a realization, or shows me doing something differently and it working. A good or hard day on its own does not count.',
	},
	{
		id: "week-in-review",
		name: "Week in review",
		scope: { kind: "days", days: 7 },
		prompt: "Review my week: the high points, the low points, and how my energy went.",
		format:
			"Use three short sections. **High points** and **Low points** are a few bullets each, with the link of the note they come from. **Energy** is two or three sentences following it day by day from the first note to today, using each note's mood and words, citing each day. End with one line: **A question for next week:** followed by a single question about a worry or decision that the last note still leaves open.",
	},
	{
		id: "open-loops",
		name: "Open loops",
		scope: { kind: "days", days: 30, beforeToday: true },
		prompt:
			'Find the plans and intentions I wrote down ("I want to…", "I should…", "try…"), and check whether any later note follows each one up.',
		format:
			'A plan is something I said I would do; leave out lessons, things already done, and other people\'s plans. Write **Still open** first: each plan no later note follows up, the link of the note where I wrote it, and what I said about it. Then **Followed up**: each plan with the link of the note where I wrote it and the link of the later note that follows it up. Put each plan under one heading only, and under Followed up only if you can give that later link. If a heading would be empty, write "None." under it.',
	},
	{
		id: "recurring-themes",
		name: "Recurring themes",
		scope: { kind: "days", days: 90 },
		prompt:
			"Which people, worries, habits and topics keep returning in these notes, and how did each one shift over time?",
		format:
			"Pick the three to five that come up most. For each, write its name in bold, then two or three sentences on how it changed, with the link of the first note that mentions it and the link of the last note that mentions it. When that last note is before {twoWeeksAgo}, write that it stopped appearing after that note.",
	},
	{
		id: "questions",
		name: "Questions to sit with",
		scope: { kind: "days", days: 14 },
		prompt: "Ask me three questions worth thinking about, each tied to a specific entry.",
		format:
			"Number the three questions. For each, give the link of the entry, one sentence on what it says, then the question. Ask about something the entry leaves open in my own life (a choice, a tension, a change it does not explain), never something it already answers, what something says, suggests or reveals about me, or what I will do next. Do not answer the questions or give advice.",
	},
];

/** How a preset's range reads in its menu item: "14 days", "earlier years". */
export function scopeLabel(scope: ReflectionScope): string {
	if (scope.kind === "this-day") return "earlier years";
	return scope.beforeToday ? `${scope.days} days before today` : `${scope.days} days`;
}
