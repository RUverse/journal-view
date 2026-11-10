/**
 * The built-in reflections. Each is a question that says which notes it is
 * about ("the last two weeks", "this date in earlier years"), which the model
 * then finds with its tools (tools.ts), and asks for its answer in a fixed
 * shape with a place for each citation: without one, small models cite
 * nothing. The wording was tuned against local models with
 * scripts/reflection-spike.mjs, as recorded in docs/plans/reflection.md;
 * change it there first.
 */

export interface ReflectionPreset {
	id: string;
	name: string;
	/** What the reader asks, saying which notes it is about. */
	prompt: string;
	/**
	 * The shape of the answer. `{twoWeeksAgo}` becomes that date, written out,
	 * since models cannot count back from today.
	 */
	format: string;
}

/** What a reflection is asked: a preset, or a question of the reader's own. */
export interface ReflectionRequest {
	/** The preset it came from, or null for a question of the reader's own. */
	presetId: string | null;
	/** What its card and note are titled: the preset's name, or the question. */
	title: string;
	prompt: string;
	format: string;
}

/** The shape asked of a question of the reader's own, which has none of its own. */
export const QUESTION_FORMAT =
	"Answer in a few short paragraphs or bullets. Give each point the link of the note it comes from. If the notes do not answer the question, say so.";

/** A preset, as a run asks it. */
export function presetRequest(preset: ReflectionPreset): ReflectionRequest {
	return {
		presetId: preset.id,
		title: preset.name,
		prompt: preset.prompt,
		format: preset.format || QUESTION_FORMAT,
	};
}

/** A question of the reader's own. */
export function questionRequest(question: string): ReflectionRequest {
	const prompt = question.trim();
	return { presetId: null, title: prompt, prompt, format: QUESTION_FORMAT };
}

/**
 * Repeated after the notes, where small models still attend to it, when a
 * run is asked for its answer. `{exampleLink}` becomes a note's link.
 */
export const REMINDER =
	'Write to me as "you". Cite only with the links exactly as written in the headings above, such as {exampleLink}, one note per link. Use only what the notes say. No praise, no advice, no closing summary.';

export const BUILT_IN_PRESETS: readonly ReflectionPreset[] = [
	{
		id: "this-day",
		name: "This day over the years",
		prompt:
			"Look at what I wrote on this date in earlier years, and today. What was I doing, worrying about and hoping for on this date each year, and what has changed since?",
		format:
			"Write one short paragraph per note, oldest first, starting with the note's link alone. Keep each paragraph to its own year: who was around me and how near they were, what I worried about, and what I hoped for. Save every comparison for two or three closing sentences that set the first note's hopes against today's note.",
	},
	{
		id: "what-i-learned",
		name: "What I learned",
		prompt: "What did I learn or realize over the last two weeks?",
		format:
			'Answer with one to three bullets and nothing else. Each is the lesson, said to me as "you", then the link of the note it comes from. A note counts when it states a realization, or shows me doing something differently and it working. A good or hard day on its own does not count.',
	},
	{
		id: "week-in-review",
		name: "Week in review",
		prompt: "Review my last seven days: the high points, the low points, and how my energy went.",
		format:
			"Use three short sections. **High points** and **Low points** are a few bullets each, with the link of the note they come from. **Energy** is two or three sentences following it day by day from the first note to today, using each note's mood and words, citing each day. End with one line: **A question for next week:** followed by a single question about a worry or decision that the last note still leaves open.",
	},
	{
		id: "open-loops",
		name: "Open loops",
		prompt:
			'Find the plans and intentions I wrote down in the 30 days up to yesterday ("I want to…", "I should…", "try…"), and check whether any later note follows each one up.',
		format:
			'A plan is something I said I would do; leave out lessons, things already done, other people\'s plans, and anything first written today. Write **Still open** first: each plan no later note follows up, the link of the note where I wrote it, and what I said about it. Then **Followed up**: each plan with the link of the note where I wrote it and the link of the later note that follows it up. Put each plan under one heading only, and under Followed up only if you can give that later link. If a heading would be empty, write "None." under it.',
	},
	{
		id: "recurring-themes",
		name: "Recurring themes",
		prompt:
			"Read my notes from the last three months. Which people, worries, habits and topics kept returning in them, and how did each one shift over time?",
		format:
			"Pick the three to five that come up most. For each, write its name in bold, then two or three sentences on how it changed, with the link of the first note that mentions it and the link of the last note that mentions it. When that last note is before {twoWeeksAgo}, write that it stopped appearing after that note.",
	},
	{
		id: "questions",
		name: "Questions to sit with",
		prompt: "Ask me three questions worth thinking about, each tied to a specific entry from the last two weeks.",
		format:
			"Number the three questions. For each, give the link of the entry, one sentence on what it says, then the question. Ask about something the entry leaves open in my own life (a choice, a tension, a change it does not explain), never something it already answers, what something says, suggests or reveals about me, or what I will do next. Do not answer the questions or give advice.",
	},
];

/** Built-in presets, by id, to tell an edited one from the shipped one. */
const BUILT_IN_BY_ID = new Map(BUILT_IN_PRESETS.map((preset) => [preset.id, preset]));

/** The presets the reader has: their own list once they changed it, the built-in ones until then. */
export function presetsOf(saved: readonly ReflectionPreset[] | null): readonly ReflectionPreset[] {
	return saved ?? BUILT_IN_PRESETS;
}

/**
 * Brings back every built-in preset as shipped - the edited ones and the
 * deleted ones, at their shipped place - and keeps the reader's own after
 * them. Null when that leaves only the built-in ones.
 */
export function restoreBuiltIns(saved: readonly ReflectionPreset[] | null): ReflectionPreset[] | null {
	const own = (saved ?? []).filter((preset) => !BUILT_IN_BY_ID.has(preset.id));
	return own.length ? [...BUILT_IN_PRESETS.map((preset) => ({ ...preset })), ...own] : null;
}

/** True when a built-in preset was edited or deleted, which restoring them would undo. */
export function canRestoreBuiltIns(saved: readonly ReflectionPreset[] | null): boolean {
	if (!saved) return false;
	return BUILT_IN_PRESETS.some((shipped) => {
		const preset = saved.find((candidate) => candidate.id === shipped.id);
		return !preset || JSON.stringify(preset) !== JSON.stringify(shipped);
	});
}

/**
 * The saved presets, keeping those that read back whole; null for none
 * saved. Presets used to fix the notes they read with a `scope`, which their
 * questions leaned on ("these two weeks"): a built-in one saved that way is
 * the shipped one again, and the reader's own keep their question.
 */
export function presetsSetting(value: unknown): ReflectionPreset[] | null {
	if (!Array.isArray(value)) return null;
	const presets: ReflectionPreset[] = [];
	const ids = new Set<string>();
	for (const item of value) {
		if (typeof item !== "object" || item === null) continue;
		const preset = item as Record<string, unknown>;
		if (
			typeof preset.id !== "string" ||
			!preset.id ||
			ids.has(preset.id) ||
			typeof preset.name !== "string" ||
			!preset.name.trim() ||
			typeof preset.prompt !== "string" ||
			!preset.prompt.trim()
		) {
			continue;
		}
		ids.add(preset.id);
		const shipped = BUILT_IN_BY_ID.get(preset.id);
		if (shipped && preset.scope !== undefined) {
			presets.push({ ...shipped });
			continue;
		}
		presets.push({
			id: preset.id,
			name: preset.name.trim(),
			prompt: preset.prompt.trim(),
			format: typeof preset.format === "string" ? preset.format.trim() : "",
		});
	}
	return presets;
}
