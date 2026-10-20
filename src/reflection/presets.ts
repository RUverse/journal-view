/**
 * The built-in reflections. Each fixes the notes it reads, so it works with
 * any model, and asks for its answer in a fixed shape with a place for each
 * citation: without one, small models cite nothing. The wording was tuned
 * against local models in the spike recorded in docs/plans/reflection.md;
 * change it there first.
 */

/** The notes a reflection reads. */
export type ReflectionScope =
	| {
			kind: "days";
			/** How many days, today included unless the range ends before today. */
			days: number;
			/** Ends yesterday: today's plans are not open loops yet. */
			beforeToday?: boolean;
	  }
	| { kind: "this-day" }
	/** Fixed dates, `YYYY-MM-DD`, for a question of the reader's own. */
	| { kind: "range"; from: string; to: string }
	/** The model picks what to read through tools, which it has to support. */
	| { kind: "model" };

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

/** What a reflection is asked: a preset, or a question of the reader's own. */
export interface ReflectionRequest {
	/** The preset it came from, or null for a question of the reader's own. */
	presetId: string | null;
	/** What its card and note are titled: the preset's name, or the question. */
	title: string;
	prompt: string;
	format: string;
	scope: ReflectionScope;
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
		scope: preset.scope,
	};
}

/** A question of the reader's own, over `scope`. */
export function questionRequest(question: string, scope: ReflectionScope): ReflectionRequest {
	const prompt = question.trim();
	return { presetId: null, title: prompt, prompt, format: QUESTION_FORMAT, scope };
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

/**
 * How a scope reads beside a preset: "14 days". Empty for a date over the
 * years, which the preset's name says.
 */
export function scopeLabel(scope: ReflectionScope): string {
	switch (scope.kind) {
		case "this-day":
			return "";
		case "model":
			return "model chooses";
		case "range":
			return scope.from === scope.to ? scope.from : `${scope.from} – ${scope.to}`;
		case "days":
			return scope.beforeToday ? `${scope.days} days before today` : `${scope.days} days`;
	}
}

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

const KEY = /^\d{4}-\d{2}-\d{2}$/;

/** A scope read from settings, or null when it is not one. */
function scopeSetting(value: unknown): ReflectionScope | null {
	if (typeof value !== "object" || value === null) return null;
	const scope = value as Record<string, unknown>;
	switch (scope.kind) {
		case "this-day":
			return { kind: "this-day" };
		case "model":
			return { kind: "model" };
		case "range":
			return typeof scope.from === "string" && KEY.test(scope.from) && typeof scope.to === "string" && KEY.test(scope.to)
				? { kind: "range", from: scope.from, to: scope.to }
				: null;
		case "days": {
			if (typeof scope.days !== "number" || !Number.isFinite(scope.days)) return null;
			const days = Math.max(1, Math.min(3650, Math.round(scope.days)));
			return scope.beforeToday === true ? { kind: "days", days, beforeToday: true } : { kind: "days", days };
		}
		default:
			return null;
	}
}

/** The saved presets, keeping those that read back whole; null for none saved. */
export function presetsSetting(value: unknown): ReflectionPreset[] | null {
	if (!Array.isArray(value)) return null;
	const presets: ReflectionPreset[] = [];
	const ids = new Set<string>();
	for (const item of value) {
		if (typeof item !== "object" || item === null) continue;
		const preset = item as Record<string, unknown>;
		const scope = scopeSetting(preset.scope);
		if (
			typeof preset.id !== "string" ||
			!preset.id ||
			ids.has(preset.id) ||
			typeof preset.name !== "string" ||
			!preset.name.trim() ||
			typeof preset.prompt !== "string" ||
			!preset.prompt.trim() ||
			!scope
		) {
			continue;
		}
		ids.add(preset.id);
		presets.push({
			id: preset.id,
			name: preset.name.trim(),
			scope,
			prompt: preset.prompt.trim(),
			format: typeof preset.format === "string" ? preset.format.trim() : "",
		});
	}
	return presets;
}
