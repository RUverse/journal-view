import {
	ANSWER_TOKENS,
	CHARS_PER_TOKEN,
	ESTIMATE_MARGIN,
	MONTHS,
	addDays,
	contextLimit,
	dayKey,
	demoteHeadings,
	estimateTokens,
	formatNote,
	longDate,
	monthEnd,
	monthsBefore,
	onThisDay,
	propertyLine,
	spreadEvenly,
} from "./context";
import type { DayRange, ReflectionSource } from "./context";
import { conversationMessages } from "./conversation";
import type { Conversation } from "./conversation";
import { QUESTION_FORMAT, REMINDER } from "./presets";
import { ProviderError } from "./provider";
import type { ChatMessage, ChatResult, ModelInfo, ReflectionProvider, ToolCall, ToolDefinition } from "./provider";
import { SearchIndex, excerptsOf, parseQuery } from "./search";
import type { AlternativeCount } from "./search";

/*
 * How a model reads the journal: the tools it is offered, what each returns,
 * and the loop that runs them until it answers. Every reflection goes
 * through here, so the model decides which notes a question needs.
 *
 * Nothing in this file touches Obsidian: the journal comes in as a
 * `JournalSource` (journal.ts builds the vault's), so
 * scripts/reflection-spike.mjs runs this very code against local models.
 * Tune the tools, their descriptions and the prompts with it.
 */

/** A note the tools can reach. */
export interface JournalNote extends ReflectionSource {
	/** The file name, which a property can restate. */
	name: string;
	properties: Map<string, string[]>;
	/** Its tags as filters compare them, such as `work` or `family/mina`. */
	tags: string[];
}

/** The journal as a run reads it. */
export interface JournalSource {
	/** Every note the journal's filters let through, up to the run's day, oldest first. */
	notes: readonly JournalNote[];
	/** A note's text as an editor holds it, or null when it cannot be read. */
	body(note: JournalNote): Promise<string | null>;
}

/** What a question needs to be answered. */
export interface ToolRunOptions {
	journal: JournalSource;
	provider: ReflectionProvider;
	/** The model's name and what it supports; it has to list `tools`. */
	model: ModelInfo;
	/** The reader's question. */
	question: string;
	/** The shape its answer takes: a preset's own, or the one for questions. */
	format: string;
	/**
	 * A follow-up to the answer `question` already has, the follow-ups before
	 * it, and the links of the notes those answers drew on.
	 */
	followUp?: { conversation: Conversation; question: string; sources: readonly string[] };
	/** The day the reflection belongs to, `YYYY-MM-DD`: nothing after it is read. */
	today: string;
	/** The Maximum context setting, in tokens. */
	maxContext: number;
	signal: AbortSignal;
	/** "5 Oct", or "5 Oct 2026", for the card's status line, in the app's language. English when left out. */
	shortDate?: (key: string, withYear: boolean) => string;
	/** The card's status line: each tool call as it happens, such as `Searching for "running"`. */
	onStatus: (line: string) => void;
	/** The answer as it streams. */
	onText: (delta: string) => void;
	/** Takes back the text streamed so far, when the round that wrote it turns out to call tools or to hold nothing. */
	onReset: () => void;
	/**
	 * The notes passed whole so far, and the days they span, after each round
	 * of calls: what a run stopped before its answer has read.
	 */
	onSources?: (sources: ReflectionSource[], range: DayRange | null) => void;
}

export interface ToolRunResult {
	text: string;
	/**
	 * Every note the tools passed the model whole, and any it saw only in a
	 * list or an excerpt that the answer cites, oldest first.
	 */
	sources: ReflectionSource[];
	/** The days those notes span, or null when it read none. */
	range: DayRange | null;
}

/** Rounds that may call tools, before the model is asked for its answer. */
const MAX_ROUNDS = 8;
/** Calls answered in one round; the rest are told to ask again. */
const MAX_CALLS_PER_ROUND = 8;
/** Kept free after a tool result, for the next call and its arguments. */
const ROUND_RESERVE = 512;
/** Below this, a tool result is not worth sending, and the model is told to answer. */
const MIN_RESULT_TOKENS = 256;
/** Added per message for the chat template's own markup. */
const MESSAGE_OVERHEAD = 16;
/**
 * An answer that is going to be sent back whatever it says is stopped once
 * it is this many characters long, rather than written out and dropped.
 */
const DOOMED_LENGTH = 240;
/**
 * The share of the whole context a search or a list may take. They are for
 * finding what to read, so they leave the room to read it in.
 */
const GLANCE_SHARE = 0.3;
/** A list of more notes than this is given by month instead. */
const MAX_LISTED_NOTES = 120;
/** The most notes one read considers; a longer range is thinned before anything is read. */
const MAX_READ_CANDIDATES = 300;
/** Characters of a note's opening, in a list. */
const PREVIEW_LENGTH = 90;
/** A search that finds this few notes, too far apart to read the days between, shows them whole when they fit. */
const WHOLE_SEARCH_NOTES = 6;
/** Notes a search shows excerpts of: the ones that match best. */
const MAX_SEARCH_NOTES = 20;
/** Notes scoring at least this share of the best one are where a subject is, whatever else mentions it in passing. */
const STRONG_SHARE = 0.5;
/**
 * A way of saying a thing that this share of the notes use, at most, is one
 * of the subject's own words, as `reorg` is and `work` beside it is not.
 */
const NARROW_SHARE = 0.15;
/**
 * The most a search passes whole as one story, from a subject's first
 * mention to its last: this many notes, and this share of the whole context
 * for all the stories of a run together, so that several wide searches at
 * once cannot fill it.
 */
const MAX_STORY_NOTES = 60;
const STORY_SHARE = 0.35;
/** A story names the notes that mention its subject while they are this few. */
const MAX_NAMED_MENTIONS = 12;
/**
 * The excerpts of each note a search shows, and the characters of each, from
 * the roomiest to the tightest: tried in turn until the result fits.
 */
const EXCERPT_SIZES: ReadonlyArray<{ excerpts: number; width: number }> = [
	{ excerpts: 2, width: 320 },
	{ excerpts: 2, width: 220 },
	{ excerpts: 1, width: 220 },
	{ excerpts: 1, width: 150 },
];
/** Notes read at once, between checks that the run has not been stopped. */
const READ_BATCH = 32;
/** Values held by at least this share of the journal's notes are left out of each note's properties. */
const SHARED_SHARE = 0.9;

const DATE_ARGUMENT = "written YYYY-MM-DD";

/**
 * The tools a model is offered. Their descriptions say when each is worth
 * calling; the results then say what to call next, which models follow far
 * better than any instruction up front.
 */
const TOOLS: ToolDefinition[] = [
	{
		name: "search_journal",
		description:
			'Find the notes that mention a word, a name or a phrase, in any of its forms: run also finds running and runs. Returns the notes that match best, each with its date, its link and the sentences around the match. Several words find the notes about all of them; commas separate other ways of saying it, such as "anxious, worried, nervous"; quotes keep words together. Use it for a question about a person, a place or a subject, then read the notes that matter with read_notes.',
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "What to find: a word, a name, a short phrase, or several separated by commas." },
				from: { type: "string", description: `The first day to search, ${DATE_ARGUMENT}. Optional.` },
				to: { type: "string", description: `The last day to search, ${DATE_ARGUMENT}. Optional.` },
			},
			required: ["query"],
		},
	},
	{
		name: "read_notes",
		description:
			"Read chosen notes in full by their dates: the ones a search or a list showed that the question needs. Each comes under a heading with the link to cite it by.",
		parameters: {
			type: "object",
			properties: {
				dates: {
					type: "array",
					items: { type: "string" },
					description: `The dates of the notes to read, each ${DATE_ARGUMENT}.`,
				},
			},
			required: ["dates"],
		},
	},
	{
		name: "read_journal",
		description:
			"Read every note in a range of days in full, oldest first, each under a heading with the link to cite it by. Use it for a question about a period, such as the last two weeks or the last three months, and to follow how something went from day to day. When a range holds more than fits, notes are left out evenly across it and you are told which.",
		parameters: {
			type: "object",
			properties: {
				from: { type: "string", description: `The first day, ${DATE_ARGUMENT}.` },
				to: { type: "string", description: `The last day, ${DATE_ARGUMENT}.` },
				tag: { type: "string", description: "Only the notes with this tag, such as work. Optional." },
			},
			required: ["from", "to"],
		},
	},
	{
		name: "list_journal",
		description:
			"List the notes in a range of days, one line each: its link, date, length in words, mood and tags, and its first words. Cheap: use it to see what a period holds before reading it.",
		parameters: {
			type: "object",
			properties: {
				from: { type: "string", description: `The first day, ${DATE_ARGUMENT}.` },
				to: { type: "string", description: `The last day, ${DATE_ARGUMENT}.` },
			},
			required: ["from", "to"],
		},
	},
	{
		name: "on_this_day",
		description: "Read in full the notes written on one day of the year in every year up to today, such as each 5 March.",
		parameters: {
			type: "object",
			properties: {
				date: {
					type: "string",
					description: `The date, ${DATE_ARGUMENT}; only its month and day count. Leave it out for today.`,
				},
			},
		},
	},
];

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

/**
 * The rules every reflection is written by. `{exampleLink}` becomes the
 * latest note's link, so the example matches the vault's own date format.
 */
const SYSTEM_PROMPT = `You answer questions about someone's private journal, which you can only see by reading it with the tools.

- Before you answer, look. For a question about a period, such as the last two weeks or the last three months, read those days with read_journal, however many they are: what the period holds is for the notes to say, not for you to guess and search for. For a question about a person, a place or a subject, find the notes with search_journal, then read the ones that matter in full with read_notes, or the days between them when the question is how something went. Excerpts and lists alone are too thin to answer from.
- Ground every point in specific notes, and cite each one with the exact link shown in its heading or line in the tool results, such as {exampleLink}.
- When the notes do not answer the question, say so instead of filling the gap.
- No praise, no generic advice, no therapy-speak.
- Write to the reader in the second person, in the language their notes are written in.
- Keep it to about 150–300 words unless the question asks otherwise.
- Never mention the tools, or suggest reading more: answer from what you have read.`;

/** After the question and the shape of its answer, since the notes come later. */
const TOOLS_REMINDER =
	'Write to me as "you". Cite only with the links exactly as the tool results show them, such as {exampleLink}, one note per link. Use only what the notes say. No praise, no advice, no closing summary.';

/**
 * Sent instead of an answer written before reading anything. Models that
 * answer at once invent notes; shown their own answer again, they go looking
 * for the notes they invented, so it is dropped unseen.
 */
const LOOK_FIRST =
	"You have not read any of my notes yet. Look in my journal with the tools first, then answer from what they show.";

/**
 * Sent instead of an answer written from search excerpts or a list alone,
 * which miss what the notes around them say. Not after a search that found
 * nothing, when the answer cites nothing: sent back after saying that no
 * note mentions Lisbon, `qwen3:8b` read the whole journal and found a dream
 * about it.
 */
const READ_FIRST =
	"Excerpts and lists are too thin to answer from. Read the notes that matter in full with read_notes first, then answer.";

/** Asks for the answer once the tools are taken away, followed by the question again. */
const ANSWER_NOW = "Answer my question now, from the notes above.";

interface ToolOutcome {
	/** The card's status line, or null when the call was refused before it ran. */
	status: string | null;
	content: string;
}

/** A range a tool was asked for, clamped to the journal, with anything worth telling the model about it. */
type RangeArgument = { from: string; to: string; notices: string[] } | { error: string };

function aborted(): ProviderError {
	return new ProviderError("aborted", "Stopped");
}

const plural = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string argument, trimmed; numbers are taken as written, anything else as missing. */
function stringArgument(value: unknown): string {
	if (typeof value === "string") return value.trim();
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/**
 * A list argument as models write them: a list of strings, or one string
 * holding several, split at commas, semicolons and line breaks.
 */
function listArgument(value: unknown): string[] {
	const items: unknown[] = Array.isArray(value) ? value : [value];
	return items
		.flatMap((item) => stringArgument(item).split(/[,;\n]/))
		.map((item) => item.trim())
		.filter(Boolean);
}

/** Removes Obsidian's display prefix and produces the comparison form of a tag, as the journal's filters do. */
function normalizeTag(value: string): string {
	return value.trim().replace(/^#+/, "").replace(/\/+$/g, "").toLocaleLowerCase();
}

const NUMBER_WORDS: Record<string, number> = {
	a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
	seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** The month a name or its first letters stand for, from 1, or 0. */
function monthNamed(name: string): number {
	const lower = name.toLowerCase().replace(/\.$/, "");
	if (lower.length < 3) return 0;
	return MONTHS.findIndex((candidate) => candidate.toLowerCase().startsWith(lower)) + 1;
}

/**
 * Reads a day as models write them. `YYYY-MM-DD` is what they are asked
 * for, perhaps with a time after it; they also write `today`, `yesterday`,
 * `2 weeks ago`, `19 October`, and a month or a year alone, of which `edge`
 * says which end is meant. Null when it is none of these.
 */
function parseDay(text: string, today: string, edge: "from" | "to"): string | null {
	const value = text.trim().toLowerCase();
	const full = /^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(value);
	if (full) return dayKey(Number(full[1]), Number(full[2]), Number(full[3]));
	if (value === "today" || value === "now") return today;
	if (value === "yesterday") return addDays(today, -1);
	const ago = /^(\d+|[a-z]+)\s+(day|week|month|year)s?\s+ago$/.exec(value);
	if (ago) {
		const count = /^\d+$/.test(ago[1]) ? Number(ago[1]) : NUMBER_WORDS[ago[1]];
		if (!count || count > 10000) return null;
		if (ago[2] === "day") return addDays(today, -count);
		if (ago[2] === "week") return addDays(today, -7 * count);
		return monthsBefore(today, ago[2] === "month" ? count : 12 * count);
	}
	const year = Number(today.slice(0, 4));
	const month = /^(\d{4})-(\d{1,2})$/.exec(value);
	if (month) {
		const number = Number(month[2]);
		if (number < 1 || number > 12) return null;
		return edge === "from" ? dayKey(Number(month[1]), number, 1) : monthEnd(Number(month[1]), number);
	}
	if (/^\d{4}$/.test(value)) return edge === "from" ? `${value}-01-01` : `${value}-12-31`;
	const named = /^([a-z]+)\.?,?\s+(\d{4})$/.exec(value);
	if (named && monthNamed(named[1])) {
		return edge === "from" ? dayKey(Number(named[2]), monthNamed(named[1]), 1) : monthEnd(Number(named[2]), monthNamed(named[1]));
	}
	// "19 October", "Oct 19" or "October 19, 2024", in this year unless it names one.
	const written = /^(?:(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)|([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?)\.?,?(?:\s+(\d{4}))?$/.exec(value);
	if (written) {
		const number = monthNamed(written[2] ?? written[3]);
		if (number) return dayKey(written[5] ? Number(written[5]) : year, number, Number(written[1] ?? written[4]));
	}
	// A month and day alone, `10-19` or `--10-19`, fall in this year.
	const short = /^-{0,2}(\d{1,2})-(\d{1,2})$/.exec(value);
	return short ? dayKey(year, Number(short[1]), Number(short[2])) : null;
}

/** What a tool answers when a date cannot be read: how to call it again, which models need spelled out. */
function dateError(text: string, name: string, tool: string): string {
	const example = `such as "${name}": "2026-10-05"`;
	if (!text) return `"${name}" is missing. Call ${tool} again with a date ${DATE_ARGUMENT}, ${example}.`;
	return `"${name}" must be a date ${DATE_ARGUMENT}, not "${text}". Call ${tool} again with one, ${example}.`;
}

/** "5 Oct", and its year when asked: the status line in English, when the caller gives no way of its own. */
function englishShortDate(key: string, withYear: boolean): string {
	const text = `${Number(key.slice(8, 10))} ${MONTHS[Number(key.slice(5, 7)) - 1].slice(0, 3)}`;
	return withYear ? `${text} ${key.slice(0, 4)}` : text;
}

/** Items joined with commas, the long tail counted rather than written out. */
function listOf(items: readonly string[], max = 20): string {
	if (items.length <= max) return items.join(", ");
	return `${items.slice(0, max).join(", ")} and ${items.length - max} more, up to ${items[items.length - 1]}`;
}

/** A note's first words, for a list, without its headings or list markers. */
function preview(body: string, length = PREVIEW_LENGTH): string {
	const text = body
		.replace(/^#+\s+.*$/gm, " ")
		.replace(/^\s*[-*+]\s+(\[.\]\s+)?/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > length ? `${text.slice(0, length).replace(/\s+\S*$/, "")}…` : text;
}

const wordCount = (body: string): number => body.match(/\S+/g)?.length ?? 0;

/** Where the JSON object opening at `start` closes, or -1. */
function closingBrace(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (char === "\\") index++;
			else if (char === '"') inString = false;
		} else if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) return index;
	}
	return -1;
}

/**
 * Tool calls a model wrote into its answer as JSON instead of making them,
 * such as `{"name": "read_journal", "parameters": {…}}`, which `llama3.1`
 * does whenever it writes a word first. Only the tools' own names count.
 */
function callsInText(text: string): ToolCall[] {
	const calls: ToolCall[] = [];
	for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
		const end = closingBrace(text, start);
		if (end === -1) break;
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(text.slice(start, end + 1));
		} catch {
			continue;
		}
		if (!isRecord(parsed) || typeof parsed.name !== "string" || !TOOL_NAMES.has(parsed.name)) continue;
		const given = parsed.parameters ?? parsed.arguments;
		calls.push({ name: parsed.name, arguments: isRecord(given) ? given : {} });
		start = end;
	}
	return calls;
}

/**
 * True when an answer holds something to read. Gemma 4 sometimes loops on
 * its own markup without writing, until the provider's cap stops it, leaving
 * a stray token such as `<channel|>`.
 */
function hasText(text: string): boolean {
	return text.replace(/<\|?[a-z_]+\|?>/g, "").trim() !== "";
}

/** The link text inside `[[…]]`. */
function linkText(link: string): string {
	const text = link.trim();
	return text.startsWith("[[") && text.endsWith("]]") ? text.slice(2, -2) : text;
}

/** True when `text` cites a note, by its link or by its link text alone, which `repairCitations` links. */
function cites(text: string, note: JournalNote): boolean {
	return text.includes(linkText(note.link));
}

/** What a search was asked, as it is told back: `"mina" or "sister"`. */
function quotedQuery(counts: readonly AlternativeCount[]): string {
	return counts.map((count) => `"${count.text.replace(/["“”]/g, "")}"`).join(" or ");
}

/**
 * Which words of a query found what, when that says more than the count of
 * notes does: a search for `trip to Lisbon` that finds a note about tripping
 * has to say that no note mentions Lisbon, and one for several ways of
 * saying a thing which of them the notes use. Empty otherwise.
 */
function wordCounts(counts: readonly AlternativeCount[], found: number): string {
	const seen = new Set<string>();
	const words = counts
		.flatMap((count) => count.parts.filter((part) => !part.common))
		.filter((word) => !seen.has(word.text) && seen.add(word.text));
	if (words.length < 2 || words.every((word) => word.notes === found)) return "";
	const texts = words.map((word) => `"${word.text}" is in ${word.notes ? plural(word.notes, "note") : "no note at all"}`);
	return `By word: ${texts.join(", ")}.`;
}

/** Where notes fall in time, such as `by month: Aug 2026 (6), Sep 2026 (1)`, by year once they span many months. */
function spreadOf(keys: readonly string[]): string {
	const months = new Map<string, number>();
	for (const key of keys) months.set(key.slice(0, 7), (months.get(key.slice(0, 7)) ?? 0) + 1);
	if (months.size <= 18) {
		const counts = [...months].map(
			([month, count]) => `${MONTHS[Number(month.slice(5)) - 1].slice(0, 3)} ${month.slice(0, 4)} (${count})`,
		);
		return `by month: ${counts.join(", ")}`;
	}
	const years = new Map<string, number>();
	for (const key of keys) years.set(key.slice(0, 4), (years.get(key.slice(0, 4)) ?? 0) + 1);
	return `by year: ${[...years].map(([year, count]) => `${year} (${count})`).join(", ")}`;
}

/** What the search index holds for a note beside its text: its name past the date, its tags and its properties. */
function extraOf(note: JournalNote, shared: Map<string, Set<string>>): string {
	const parts = [note.name.replace(/^\d{4}-\d{2}-\d{2}/, ""), ...note.tags];
	for (const [key, values] of note.properties) {
		for (const value of values) if (!shared.get(key)?.has(value)) parts.push(value);
	}
	return parts.join(" ");
}

/**
 * The journal as a run's tools read it: every note the source holds, and
 * what the model has been shown of each. Note texts are read once and kept
 * for the run; the search index is built the first time a search needs it.
 */
class JournalReader {
	readonly notes: readonly JournalNote[];
	/** Per property, the values nearly every note holds, such as `type: daily`, which tell the model nothing. */
	readonly shared: Map<string, Set<string>>;
	/** Notes whose whole body was passed, by path. */
	readonly read = new Map<string, JournalNote>();
	/** Notes seen only in a list or an excerpt, by path. */
	readonly glimpsed = new Map<string, JournalNote>();
	/** Paths a search found, which a read keeps first when not all fit. */
	private readonly hits = new Set<string>();
	/** Searches run, whether or not they found anything. */
	private searches = 0;
	/** Characters passed as stories so far, against what a run may spend on them. */
	private storyLength = 0;
	private readonly first: string;
	private readonly bodies = new Map<string, Promise<string | null>>();
	private searchable: Promise<{ index: SearchIndex; texts: string[] }> | null = null;

	constructor(
		private readonly source: JournalSource,
		/** The run's day, `YYYY-MM-DD`: nothing after it is read. */
		readonly today: string,
		/** The characters the model's whole context holds, which bounds what a search or a list returns. */
		private readonly capacity: number,
		private readonly shortDate: (key: string, withYear: boolean) => string,
		private readonly signal: AbortSignal,
	) {
		this.notes = source.notes.filter((note) => note.key <= today);
		this.first = this.notes[0]?.key ?? today;
		this.shared = sharedAcross(this.notes);
	}

	get latest(): JournalNote | null {
		return this.notes[this.notes.length - 1] ?? null;
	}

	/**
	 * True when an answer written from excerpts and lists leans on them: a
	 * search found something, the answer cites a note, or the model never
	 * searched and so knows the notes only by their first words.
	 */
	leansOnGlimpses(text: string): boolean {
		return this.hits.size > 0 || this.searches === 0 || this.cites(text);
	}

	/** True when `text` cites a note, or names one the model has seen only in a list or an excerpt. */
	private cites(text: string): boolean {
		if (text.includes("[[")) return true;
		for (const note of this.glimpsed.values()) if (cites(text, note)) return true;
		return false;
	}

	/** Runs one call, whose arguments are as the model wrote them, within `room` characters. */
	async run(call: ToolCall, room: number): Promise<ToolOutcome> {
		const args = call.arguments;
		switch (call.name) {
			case "search_journal":
				return this.search(args, room);
			case "read_notes":
				return this.readNotes(args, room);
			case "read_journal":
				return this.readRange(args, room);
			case "list_journal":
				return this.list(args, Math.min(room, this.capacity * GLANCE_SHARE));
			case "on_this_day":
				return this.onThisDay(args, room);
			default:
				return {
					status: null,
					content: `There is no tool named "${call.name}". The tools are ${[...TOOL_NAMES].join(", ")}.`,
				};
		}
	}

	/** The notes `cited` mentions or that were read whole, oldest first, as the run's sources. */
	sources(cited: string): JournalNote[] {
		const notes = [...this.read.values()];
		for (const note of this.glimpsed.values()) if (cites(cited, note)) notes.push(note);
		return notes.sort((left, right) => left.key.localeCompare(right.key) || left.path.localeCompare(right.path));
	}

	/** The days of the notes among `links` that the journal still holds, oldest first. */
	daysOf(links: readonly string[]): string[] {
		const wanted = new Set(links.map(linkText));
		return [...new Set(this.notes.filter((note) => wanted.has(linkText(note.link))).map((note) => note.key))];
	}

	private async search(args: Record<string, unknown>, room: number): Promise<ToolOutcome> {
		this.searches++;
		// Models pass several words as a list as often as in one string.
		const asked = listArgument(args.query ?? args.q ?? args.keywords ?? args.words).join(", ");
		const alternatives = parseQuery(asked);
		if (!alternatives.length) {
			return {
				status: null,
				content: `"query" is empty. Call search_journal again with a word, a name or a short phrase to find.`,
			};
		}
		const range = this.range(args, "search_journal", true);
		if ("error" in range) return { status: null, content: range.error };
		const { from, to, notices } = range;
		const withYear = this.withYear(from, to);
		// What excerpts may take: they are for finding what to read, so they leave the room to read it in.
		const glance = Math.min(room, this.capacity * GLANCE_SHARE);
		// Said only for a search that was given days: without them it is the whole journal.
		const span =
			from === this.first && to === this.today ? "" : ` from ${longDate(from, withYear)} to ${longDate(to, withYear)}`;
		const { index, texts } = await this.index();
		const result = index.search(alternatives, (doc) => this.notes[doc].key >= from && this.notes[doc].key <= to);
		const quoted = quotedQuery(result.counts);
		const status = `Searching for ${quoted}`;
		if (!result.hits.length) {
			return {
				status,
				content: [
					...notices,
					`No note${span} mentions ${quoted}. Try another word for it, such as a synonym, a name or a shorter form, or list_journal to see what the notes cover.`,
				].join("\n"),
			};
		}
		const found = result.hits.map((hit) => ({ ...hit, note: this.notes[hit.doc], body: texts[hit.doc] }));
		const foundPaths = new Set(found.map((hit) => hit.note.path));
		for (const path of foundPaths) this.hits.add(path);
		const byWord = wordCounts(result.counts, found.length);
		// A query of several words is matched by a note holding some of them, which "mentions" would overstate.
		const several = result.counts.some((count) => count.parts.filter((part) => !part.common).length > 1);
		const verb = several ? (found.length === 1 ? "matches" : "match") : found.length === 1 ? "mentions" : "mention";

		const lineFor = (hit: (typeof found)[number], excerpts: number, width: number) => {
			const parts = [hit.note.link, longDate(hit.note.key, withYear)];
			const properties = propertyLine(hit.note, this.shared);
			if (properties) parts.push(properties);
			const stretches = excerptsOf(hit.body, result.locate(hit.body), excerpts, width);
			// Found by a tag, a property or its name, which its text does not show.
			const text = stretches.length ? stretches.join(" ") : preview(hit.body, width);
			return `- ${parts.join(" · ")}: ${text}`;
		};

		// What happened to a subject is as often in the days between its mentions,
		// in notes that never name it, which no search for it finds. So when the
		// days from its first mention to its last are few enough to read, they
		// are all passed, whole. Failing that, the days of the notes that use
		// the subject's own words are, when the query also holds a word half the
		// journal uses; and failing that the days of the notes that match best,
		// which leaves out a stray mention years away.
		const story = (docs: readonly number[]): JournalNote[] | null => {
			// Not `Math.min(...docs)`: a name can be in more notes than a call takes arguments.
			let earliest = docs[0];
			let latest = docs[0];
			for (const doc of docs) {
				if (doc < earliest) earliest = doc;
				if (doc > latest) latest = doc;
			}
			const first = this.notes[earliest].key;
			const last = this.notes[latest].key;
			const notes: JournalNote[] = [];
			// Only what was not passed yet takes room: those notes are named, not repeated.
			let length = 0;
			let mentions = 0;
			for (const [doc, note] of this.notes.entries()) {
				if (note.key < first || note.key > last) continue;
				notes.push(note);
				if (!this.read.has(note.path)) length += texts[doc].length + 160;
				if (foundPaths.has(note.path)) mentions++;
			}
			const allowed = Math.min(room * 0.9, this.capacity * STORY_SHARE - this.storyLength);
			if (notes.length <= mentions || mentions < 2 || notes.length > MAX_STORY_NOTES || !length || length > allowed) return null;
			this.storyLength += length;
			return notes;
		};
		// Not for a query that the notes meet only in part: the days around
		// `holiday` are not the story of a holiday in Lisbon that no note mentions.
		const met = new Set(
			result.counts.flatMap((count, at) => (count.parts.every((part) => part.common || part.notes > 0) ? [at] : [])),
		);
		const told = found.filter((hit) => hit.matched.some((at) => met.has(at)));
		const searched = this.notesIn(from, to).length;
		const narrow = new Set(
			result.counts.flatMap((count, at) => (count.notes <= Math.max(3, searched * NARROW_SHARE) ? [at] : [])),
		);
		const own = told.filter((hit) => hit.matched.some((at) => narrow.has(at))).map((hit) => hit.doc);
		const days = !told.length
			? null
			: (story(told.map((hit) => hit.doc)) ??
				(own.length && own.length < told.length ? story(own) : null) ??
				story(told.filter((hit) => hit.score >= told[0].score * STRONG_SHARE).map((hit) => hit.doc)));
		if (days) {
			const first = days[0].key;
			const last = days[days.length - 1].key;
			const inside = found.filter((hit) => hit.note.key >= first && hit.note.key <= last);
			const between = `between ${longDate(first, withYear)} and ${longDate(last, withYear)}`;
			// The ones left out match least: a word in passing, far from the rest.
			const where =
				inside.length === found.length ? `all ${between}` : `most strongly ${between}, where ${inside.length} of them are`;
			const mentions = [...inside].sort((left, right) => left.doc - right.doc).map((hit) => hit.note.link);
			const content = await this.pass(days, withYear, room, (passed, total) =>
				[
					...notices,
					`${plural(found.length, "note")}${span} ${verb} ${quoted}, ${where}.${byWord ? ` ${byWord}` : ""}`,
					// Which of the days below name it, while that is few enough to be worth saying.
					...(mentions.length <= MAX_NAMED_MENTIONS ? [`They are ${mentions.join(", ")}.`] : []),
					`What happened is as often in the days between, in notes that never name it, so here is every note of those days in full, oldest first (${counted(passed, total)}):`,
				].join("\n"),
			);
			return { status, content };
		}

		// A handful of short notes is shown whole: reading them would be the next call anyway.
		const whole = found.reduce((sum, hit) => sum + hit.body.length + 160, 0);
		if (found.length <= WHOLE_SEARCH_NOTES && whole <= glance * 0.9) {
			const notes = [...found].sort((left, right) => left.doc - right.doc).map((hit) => hit.note);
			const content = await this.pass(notes, withYear, glance, () =>
				[
					...notices,
					`Only ${plural(found.length, "note")}${span} ${verb} ${quoted}${byWord ? `. ${byWord}` : "."} ${found.length === 1 ? "Here it is in full:" : "Here they are in full, oldest first:"}`,
				].join("\n"),
			);
			return { status, content };
		}

		/** The `count` best notes, and always the first and the last mention, in the journal's order. */
		const shown = (count: number) => {
			const best = found.slice(0, count);
			if (count < found.length && count >= 3) {
				const byDay = [...found].sort((left, right) => left.doc - right.doc);
				for (const edge of [byDay[0], byDay[byDay.length - 1]]) {
					if (best.includes(edge)) continue;
					// In place of the weakest shown that is not itself an edge.
					for (let index = best.length - 1; index >= 0; index--) {
						if (best[index] === byDay[0] || best[index] === byDay[byDay.length - 1]) continue;
						best[index] = edge;
						break;
					}
				}
			}
			return best.sort((left, right) => left.doc - right.doc);
		};
		const compose = (count: number, excerpts: number, width: number) => {
			const notes = shown(count);
			const some = notes.length < found.length;
			const best = found.filter((hit) => notes.includes(hit)).slice(0, 2);
			const example = best.sort((left, right) => left.doc - right.doc).map((hit) => `"${hit.note.key}"`);
			return [
				...notices,
				`${plural(found.length, "note")}${span} ${verb} ${quoted}${some ? `; the ${notes.length} that match best are shown` : ""}, oldest first.`,
				...(byWord ? [byWord] : []),
				...(some ? [`All of them, ${spreadOf(found.map((hit) => hit.note.key).sort())}. Search a shorter range to see the others.`] : []),
				"",
				...notes.map((hit) => lineFor(hit, excerpts, width)),
				"",
				`These are only excerpts, and only of the notes that use these words: too thin to answer from. Now read the notes that matter in full, with read_notes and their dates, such as {"dates": [${example.join(", ")}]}.`,
			].join("\n");
		};
		let count = Math.min(found.length, MAX_SEARCH_NOTES);
		let size = 0;
		let content = compose(count, EXCERPT_SIZES[size].excerpts, EXCERPT_SIZES[size].width);
		while (content.length > glance && size < EXCERPT_SIZES.length - 1) {
			size++;
			content = compose(count, EXCERPT_SIZES[size].excerpts, EXCERPT_SIZES[size].width);
		}
		while (content.length > glance && count > 1) {
			count--;
			content = compose(count, EXCERPT_SIZES[size].excerpts, EXCERPT_SIZES[size].width);
		}
		this.glimpse(shown(count).map((hit) => hit.note));
		return { status, content };
	}

	private async readNotes(args: Record<string, unknown>, room: number): Promise<ToolOutcome> {
		const given = listArgument(args.dates ?? args.date ?? args.notes ?? args.days);
		if (!given.length) {
			return {
				status: null,
				content: `"dates" is missing. Call read_notes again with the dates of the notes to read, such as {"dates": ["${this.latest?.key ?? this.today}"]}.`,
			};
		}
		const wanted = new Map<string, JournalNote>();
		const missing: string[] = [];
		for (const item of given) {
			const text = linkText(item);
			const key = parseDay(text, this.today, "from");
			const notes = key
				? this.notesIn(key, key)
				: this.notes.filter((note) => linkText(note.link) === text || note.name === text);
			if (!notes.length) missing.push(key ?? text);
			for (const note of notes) wanted.set(note.path, note);
		}
		const notes = [...wanted.values()].sort(
			(left, right) => left.key.localeCompare(right.key) || left.path.localeCompare(right.path),
		);
		const notices = missing.length ? [`There is no note on ${listOf(missing)}.${this.nearest(missing)}`] : [];
		if (!notes.length) return { status: null, content: notices.join("\n") };
		const from = notes[0].key;
		const to = notes[notes.length - 1].key;
		const withYear = this.withYear(from, to);
		const status =
			notes.length === 1
				? `Reading ${this.shortDate(from, withYear)}`
				: `Reading ${plural(notes.length, "note")} · ${this.spanLabel(from, to)}`;
		const content = await this.pass(notes, withYear, room, (passed, total) =>
			[...notices, `${counted(passed, total)} in full, oldest first:`].join("\n"),
		);
		return { status, content };
	}

	/** The notes on either side of days that hold none, to read instead. */
	private nearest(missing: readonly string[]): string {
		const near = new Set<string>();
		for (const key of missing) {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
			let before: string | null = null;
			let after: string | null = null;
			for (const note of this.notes) {
				if (note.key < key) before = note.key;
				else if (note.key > key) {
					after = note.key;
					break;
				}
			}
			if (before) near.add(before);
			if (after) near.add(after);
		}
		return near.size ? ` The nearest notes are on ${listOf([...near].sort(), 8)}.` : "";
	}

	private async list(args: Record<string, unknown>, room: number): Promise<ToolOutcome> {
		const range = this.range(args, "list_journal", true);
		if ("error" in range) return { status: null, content: range.error };
		const { from, to, notices } = range;
		const notes = this.notesIn(from, to);
		const withYear = this.withYear(from, to);
		const span = `${longDate(from, withYear)} to ${longDate(to, withYear)}`;
		const status = `Listing ${this.spanLabel(from, to)}`;
		if (!notes.length) return { status, content: [...notices, `There are no notes from ${span}.`].join("\n") };
		if (notes.length <= MAX_LISTED_NOTES) {
			const lines = await this.inBatches(notes, async (note) => {
				const body = await this.bodyOf(note);
				const properties = propertyLine(note, this.shared);
				const parts = [note.link, longDate(note.key, withYear)];
				if (body !== null) parts.push(plural(wordCount(body), "word"));
				if (properties) parts.push(properties);
				const opening = body ? preview(body) : "";
				return `- ${parts.join(" · ")}${opening ? `: ${opening}` : ""}`;
			});
			const content = [
				...notices,
				`${plural(notes.length, "note")} from ${span}, oldest first. Read the ones that matter with read_notes, or all of them with read_journal.`,
				"",
				...lines,
			].join("\n");
			if (content.length <= room) {
				this.glimpse(notes);
				return { status, content };
			}
		}
		const months = byMonth(notes, this.shared);
		let content = [
			...notices,
			`${plural(notes.length, "note")} from ${span}: too many to list one by one, so here they are by month. List a shorter range to see each note.`,
			"",
			...months,
		].join("\n");
		if (content.length > room) {
			content = `${plural(notes.length, "note")} from ${span}: too many to list in the room left. List a shorter range.`;
		}
		return { status, content };
	}

	private async readRange(args: Record<string, unknown>, room: number): Promise<ToolOutcome> {
		const range = this.range(args, "read_journal", false);
		if ("error" in range) return { status: null, content: range.error };
		const { from, to, notices } = range;
		const tag = normalizeTag(stringArgument(args.tag));
		const withYear = this.withYear(from, to);
		const span = `${longDate(from, withYear)} to ${longDate(to, withYear)}`;
		const status = `Reading ${this.spanLabel(from, to)}${tag ? ` · #${tag}` : ""}`;
		const inRange = this.notesIn(from, to);
		if (!inRange.length) return { status, content: [...notices, `There are no notes from ${span}.`].join("\n") };
		let notes = tag
			? inRange.filter((note) => note.tags.some((candidate) => candidate === tag || candidate.startsWith(`${tag}/`)))
			: inRange;
		if (!notes.length) {
			// Models take a topic for a tag, and rarely call again without it.
			const tags = tagCounts(inRange, this.shared, 8);
			notices.push(`None of these notes has the tag ${tag}${tags ? `; their tags are ${tags}` : ""}. Here they all are.`);
			notes = inRange;
		}
		const tagged = notes !== inRange;
		const content = await this.pass(notes, withYear, room, (passed, total) =>
			[
				...notices,
				`My notes from ${span}${tagged ? ` tagged ${tag}` : ""}, oldest first (${counted(passed, total)}):`,
			].join("\n"),
		);
		return { status, content };
	}

	private async onThisDay(args: Record<string, unknown>, room: number): Promise<ToolOutcome> {
		const asked = stringArgument(args.date);
		// Models often write the date out, "19 October": read it, or fall back to today.
		const key = asked ? parseDay(asked, this.today, "from") : this.today;
		const notices: string[] = key ? [] : [`"${asked}" is not a date written YYYY-MM-DD, so today's date was used.`];
		// Only the month and day count: models pass the first year as often as today.
		const date = key ?? this.today;
		const day = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
		const status =
			date.slice(5) === this.today.slice(5)
				? "Looking at this date in earlier years"
				: `Looking at ${this.shortDate(date, false)} in earlier years`;
		const found = this.notes.filter((note) => onThisDay(note.key, date));
		if (!found.length) {
			return {
				status,
				content: [...notices, `No note falls on ${day} in any year. Try list_journal for the days around it.`].join("\n"),
			};
		}
		if (new Set(found.map((note) => note.key.slice(0, 4))).size === 1) {
			notices.push(`Only ${found[0].key.slice(0, 4)} has a note on ${day}.`);
		}
		const content = await this.pass(found, true, room, (passed, total) =>
			[...notices, `My notes from ${day} in every year, oldest first (${counted(passed, total)}):`].join("\n"),
		);
		return { status, content };
	}

	/**
	 * Passes `notes` whole within `room` characters. Notes already passed are
	 * named rather than repeated. When the rest do not fit, whole notes are
	 * dropped evenly across them, keeping first the ones a search found, and
	 * the dropped ones are named as plain dates, not links, so the model can
	 * read them by themselves but not cite what it has not read.
	 */
	private async pass(
		notes: readonly JournalNote[],
		withYear: boolean,
		room: number,
		header: (passed: number, total: number) => string,
	): Promise<string> {
		const repeated = notes.filter((note) => this.read.has(note.path));
		const unread = notes.filter((note) => !this.read.has(note.path));
		const already = repeated.length
			? `Already shown above, so not repeated: ${listOf(repeated.map((note) => note.link))}.`
			: "";
		if (!unread.length) return `${already} Answer from them, or read other notes.`;
		// A range of years is thinned before anything is read: far fewer fit.
		const fresh =
			unread.length > MAX_READ_CANDIDATES
				? this.prioritized(unread, MAX_READ_CANDIDATES).map((index) => unread[index])
				: unread;
		const bodies = await this.inBatches(fresh, (note) => this.bodyOf(note));
		const readable: JournalNote[] = [];
		const sections: string[] = [];
		for (const [index, note] of fresh.entries()) {
			const body = bodies[index];
			if (body === null) continue;
			readable.push(note);
			sections.push(formatNote({ ...note, body: demoteHeadings(body.trim()) }, withYear, this.shared));
		}
		const total = unread.length;
		const compose = (kept: readonly number[]) => {
			const keptPaths = new Set(kept.map((index) => readable[index].path));
			const left = unread.filter((note) => !keptPaths.has(note.path));
			const parts = [header(kept.length, total)];
			if (already) parts.push(already);
			if (kept.length) parts.push(kept.map((index) => sections[index]).join("\n\n"));
			else if (readable.length) parts.push("None of them fit in the room left. Answer from the notes above.");
			if (left.length) {
				parts.push(
					`Not shown, for want of room: ${listOf(left.map((note) => note.key))}. To see them, read fewer days at a time, or only the ones you need with read_notes.`,
				);
			}
			return parts.join("\n\n");
		};
		const fits = (count: number) => compose(this.prioritized(readable, count)).length <= room;
		let count = readable.length;
		if (!fits(count)) {
			// No more notes fit than the shortest ones would; counts below that
			// are tried in turn, since a larger count spread evenly is not
			// always longer.
			const shortest = sections.map((section) => section.length).sort((left, right) => left - right);
			let length = header(0, total).length + already.length + 200;
			let ceiling = 0;
			while (ceiling < shortest.length && length + shortest[ceiling] + 2 <= room) length += shortest[ceiling++] + 2;
			count = ceiling;
			while (count > 0 && !fits(count)) count--;
		}
		const kept = this.prioritized(readable, count);
		for (const index of kept) {
			this.read.set(readable[index].path, readable[index]);
			this.glimpsed.delete(readable[index].path);
		}
		return compose(kept);
	}

	/** The indexes of `count` of `notes`: the ones a search found first, each group spread evenly, in order. */
	private prioritized(notes: readonly JournalNote[], count: number): number[] {
		if (count >= notes.length) return notes.map((_, index) => index);
		const found: number[] = [];
		const others: number[] = [];
		for (const [index, note] of notes.entries()) (this.hits.has(note.path) ? found : others).push(index);
		if (count <= found.length) return spreadEvenly(found.length, count).map((index) => found[index]);
		const rest = spreadEvenly(others.length, count - found.length).map((index) => others[index]);
		return [...found, ...rest].sort((left, right) => left - right);
	}

	/**
	 * Checks a range's dates and clamps it to the journal: from its first note
	 * to the run's day. An optional range left out is the whole journal; one
	 * given the wrong way round is swapped, and the model told.
	 */
	private range(args: Record<string, unknown>, tool: string, optional: boolean): RangeArgument {
		const fromText = stringArgument(args.from);
		const toText = stringArgument(args.to);
		const from = fromText || !optional ? parseDay(fromText, this.today, "from") : this.first;
		if (!from) return { error: dateError(fromText, "from", tool) };
		const to = toText || !optional ? parseDay(toText, this.today, "to") : this.today;
		if (!to) return { error: dateError(toText, "to", tool) };
		const notices: string[] = [];
		let start = from;
		let end = to;
		if (start > end) {
			[start, end] = [end, start];
			notices.push(`"from" was after "to", so they were swapped.`);
		}
		if (start > this.today) {
			return { error: `${start} is after today, ${this.today}, so there are no notes yet. Call ${tool} again with an earlier range.` };
		}
		if (end > this.today) end = this.today;
		if (start < this.first) start = this.first;
		return { from: start, to: end, notices };
	}

	private notesIn(from: string, to: string): JournalNote[] {
		return this.notes.filter((note) => note.key >= from && note.key <= to);
	}

	/** Headings carry the year when the range leaves this year. */
	private withYear(from: string, to: string): boolean {
		return from.slice(0, 4) !== to.slice(0, 4) || to.slice(0, 4) !== this.today.slice(0, 4);
	}

	/** "5 Oct – 19 Oct", with years when the range leaves this year. */
	private spanLabel(from: string, to: string): string {
		const withYear = this.withYear(from, to);
		return from === to
			? this.shortDate(from, withYear)
			: `${this.shortDate(from, withYear)} – ${this.shortDate(to, withYear)}`;
	}

	private glimpse(notes: readonly JournalNote[]): void {
		for (const note of notes) if (!this.read.has(note.path)) this.glimpsed.set(note.path, note);
	}

	/** A note's text, read once for the run. */
	private bodyOf(note: JournalNote): Promise<string | null> {
		let body = this.bodies.get(note.path);
		if (!body) this.bodies.set(note.path, (body = this.source.body(note)));
		return body;
	}

	/**
	 * Every note's text, indexed for search, the first time a search asks.
	 * Notes are read and indexed a batch at a time, so a long journal does
	 * not hold the app up while it is indexed.
	 */
	private index(): Promise<{ index: SearchIndex; texts: string[] }> {
		this.searchable ??= (async () => {
			const index = new SearchIndex();
			const texts = await this.inBatches(this.notes, async (note) => (await this.bodyOf(note)) ?? "");
			for (const [at, note] of this.notes.entries()) {
				index.add({ body: texts[at], extra: extraOf(note, this.shared) });
				if (at % READ_BATCH === READ_BATCH - 1) {
					await Promise.resolve();
					if (this.signal.aborted) throw aborted();
				}
			}
			return { index, texts };
		})();
		return this.searchable;
	}

	/** Maps `notes` a batch at a time, stopping between batches when the run is stopped. */
	private async inBatches<T>(notes: readonly JournalNote[], map: (note: JournalNote) => Promise<T>): Promise<T[]> {
		const results: T[] = [];
		for (let start = 0; start < notes.length; start += READ_BATCH) {
			if (this.signal.aborted) throw aborted();
			results.push(...(await Promise.all(notes.slice(start, start + READ_BATCH).map(map))));
		}
		if (this.signal.aborted) throw aborted();
		return results;
	}
}

/** "9 notes", or "9 of 31 notes" when not all were passed. */
function counted(passed: number, total: number): string {
	return passed === total ? plural(total, "note") : `${passed} of ${plural(total, "note")}`;
}

/**
 * Per property, the values held by nearly every note in the journal, such as
 * `type: daily`. One odd note would keep it on every other, so nearly every
 * note is enough.
 */
function sharedAcross(notes: readonly JournalNote[]): Map<string, Set<string>> {
	const shared = new Map<string, Set<string>>();
	if (notes.length < 2) return shared;
	const counts = new Map<string, Map<string, number>>();
	for (const note of notes) {
		for (const [key, values] of note.properties) {
			const byValue = counts.get(key) ?? new Map<string, number>();
			counts.set(key, byValue);
			for (const value of new Set(values)) byValue.set(value, (byValue.get(value) ?? 0) + 1);
		}
	}
	for (const [key, byValue] of counts) {
		const common = [...byValue].filter(([, count]) => count >= notes.length * SHARED_SHARE).map(([value]) => value);
		if (common.length) shared.set(key, new Set(common));
	}
	return shared;
}

/** The tags notes hold, most used first, such as `work (8), family (5)`, leaving out those nearly every note holds. */
function tagCounts(notes: readonly JournalNote[], shared: Map<string, Set<string>>, max: number): string {
	const common = new Set([...(shared.get("tags") ?? [])].map(normalizeTag));
	const counts = new Map<string, number>();
	for (const note of notes) {
		for (const tag of note.tags) if (!common.has(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
	}
	return [...counts]
		.sort((left, right) => right[1] - left[1])
		.slice(0, max)
		.map(([tag, count]) => `${tag} (${count})`)
		.join(", ");
}

/** A long range by month: how many notes, and their most used tags. */
function byMonth(notes: readonly JournalNote[], shared: Map<string, Set<string>>): string[] {
	const months = new Map<string, JournalNote[]>();
	for (const note of notes) {
		const month = note.key.slice(0, 7);
		const inMonth = months.get(month) ?? [];
		inMonth.push(note);
		months.set(month, inMonth);
	}
	return [...months].map(([month, inMonth]) => {
		const tags = tagCounts(inMonth, shared, 6);
		return `- ${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}: ${plural(inMonth.length, "note")}${tags ? ` · tags: ${tags}` : ""}`;
	});
}

/**
 * Today, and the days that the usual ways of asking for a period start on.
 * Models cannot count back from today, so the dates are written in, as the
 * tools take them.
 */
function dateTable(today: string): string {
	const began = (days: number) => addDays(today, 1 - days);
	return [
		`Today is ${longDate(today, true)} (${today}), and yesterday was ${addDays(today, -1)}.`,
		`Counting today, the last week (7 days) began on ${began(7)}, the last two weeks (14 days) on ${began(14)}, the last month (30 days) on ${began(30)}, the last three months (90 days) on ${began(90)}, and the last year on ${addDays(monthsBefore(today, 12), 1)}.`,
	].join(" ");
}

/** How long a conversation is in characters, tools included, to estimate its tokens. */
function conversationLength(messages: readonly ChatMessage[], tools: readonly ToolDefinition[] | undefined): number {
	let length = tools ? JSON.stringify(tools).length : 0;
	for (const message of messages) {
		length += message.content.length + MESSAGE_OVERHEAD;
		if (message.role === "assistant" && message.toolCalls?.length) length += JSON.stringify(message.toolCalls).length;
	}
	return length;
}

/**
 * Answers a question by letting the model read the journal through tools:
 * searching it, reading the notes it picks or a range of days, listing a
 * period, and reading this date over the years. Stops offering tools after
 * a few rounds and asks for the answer.
 *
 * The context is asked for whole, since how much the model will read is not
 * known up front, and every result is cut to the room the conversation has
 * left. A model that answers before reading anything, or from search
 * excerpts alone, is sent back once for each; while an answer would be sent
 * back it is not streamed, so the card does not show an answer and take it
 * away. Throws `ProviderError("no-tools")` from the provider when the model
 * cannot call tools, and `ProviderError("failed")` when it ends without an
 * answer.
 */
export async function reflectWithTools(options: ToolRunOptions): Promise<ToolRunResult> {
	const { provider, model, signal } = options;
	if (signal.aborted) throw aborted();
	// The whole context from the first round: changing it between rounds
	// would make Ollama load the model again each time.
	const limit = contextLimit(model.contextLength, options.maxContext);
	const journal = new JournalReader(
		options.journal,
		options.today,
		limit * CHARS_PER_TOKEN,
		options.shortDate ?? englishShortDate,
		signal,
	);
	const latest = journal.latest;
	if (!latest) throw new ProviderError("failed", "There are no notes to read yet");
	// Models cannot count back from today, so a date a preset's shape names is written in.
	const twoWeeksAgo = longDate(addDays(journal.today, -14), true);
	const fill = (text: string) =>
		text.replace(/\{(exampleLink|twoWeeksAgo)\}/g, (_match, name: string) =>
			name === "exampleLink" ? latest.link : twoWeeksAgo,
		);
	const system = [
		fill(SYSTEM_PROMPT),
		"",
		dateTable(journal.today),
		`The journal holds ${plural(journal.notes.length, "note")}, from ${longDate(journal.notes[0].key, true)} to ${longDate(latest.key, true)}.`,
	].join("\n");
	const messages: ChatMessage[] = [
		{ role: "system", content: system },
		{ role: "user", content: fill(`${options.question}\n\n${options.format}\n\n${TOOLS_REMINDER}`) },
	];
	const { followUp } = options;
	if (followUp) {
		// The notes read for earlier answers are not kept, so a follow-up is told where they were.
		const days = journal.daysOf(followUp.sources);
		const before = days.length
			? `The answers above drew on my notes from ${listOf(days, 40)}. Those notes are no longer in front of you: read the ones this needs again with read_notes, or look further.\n\n`
			: "";
		messages.push(
			...conversationMessages(followUp.conversation, followUp.question, fill(`${before}${QUESTION_FORMAT}\n\n${TOOLS_REMINDER}`)),
		);
	}
	const question = followUp?.question ?? options.question;
	const format = followUp ? QUESTION_FORMAT : options.format;
	// After each round's results, where a model still attends to it: by the
	// time the notes are in, the question and its shape are far above them.
	const task = fill(
		`\n\n---\n\nOnce you have read the notes it needs, answer my question: ${question}\n\n${format}\n\n${TOOLS_REMINDER}`,
	);

	/** Tokens the server counts per estimated token, raised whenever it counts more. */
	let ratio = ESTIMATE_MARGIN;
	/** The characters a tool result may take: what is left once the answer and the next call have room. */
	const room = () => {
		const used = estimateTokens(conversationLength(messages, TOOLS) + MESSAGE_OVERHEAD) * ratio;
		return Math.floor(((limit - used - ANSWER_TOKENS - ROUND_RESERVE) / ratio) * CHARS_PER_TOKEN);
	};
	if (room() < MIN_RESULT_TOKENS * CHARS_PER_TOKEN) {
		throw new ProviderError(
			"failed",
			"The model's context is too small to read the journal. Raise Maximum context in the Reflect window's settings.",
		);
	}

	/**
	 * One request; its text is streamed to the card only when `live`. A
	 * `doomed` one is stopped as soon as it is plainly an answer rather than
	 * a call, since that answer would be dropped: a model that answers from
	 * excerpts otherwise spends seconds writing what nobody reads.
	 */
	const send = async (tools: ToolDefinition[] | undefined, live: boolean, doomed = false) => {
		let streamed = false;
		let text = "";
		const length = conversationLength(messages, tools);
		const cut = new AbortController();
		const stop = () => cut.abort();
		signal.addEventListener("abort", stop, { once: true });
		try {
			const result: ChatResult = await provider.chat({
				model: model.name,
				messages,
				numCtx: limit,
				signal: cut.signal,
				tools,
				onText: (delta) => {
					text += delta;
					// Not a call written out as text, which starts with its brace.
					if (doomed && text.length > DOOMED_LENGTH && !text.trimStart().startsWith("{")) cut.abort();
					if (!live) return;
					streamed = true;
					options.onText(delta);
				},
			});
			if (result.promptTokens) ratio = Math.max(ratio, result.promptTokens / estimateTokens(length));
			return { result, streamed };
		} catch (error) {
			if (signal.aborted || !cut.signal.aborted) throw error;
			// Stopped here, not by the reader: what it wrote so far stands for the answer.
			const result: ChatResult = { text, promptTokens: null, doneReason: null, streamed: true, toolCalls: [] };
			return { result, streamed };
		} finally {
			signal.removeEventListener("abort", stop);
		}
	};

	const asked = new Set<string>();
	const nudged = new Set<string>();
	let looked = false;
	let full = false;
	/** What the model may be sent instead of an answer this round; while there is something, the answer is held back. */
	const nudgeFor = () => {
		if (!looked) return nudged.has(LOOK_FIRST) ? null : LOOK_FIRST;
		return !journal.read.size && journal.glimpsed.size && !nudged.has(READ_FIRST) ? READ_FIRST : null;
	};
	/** Whether an answer is sent back with `nudge`: always before looking, and from excerpts when it leans on them. */
	const sendsBack = (nudge: string, text: string) =>
		nudge === LOOK_FIRST || (nudge === READ_FIRST && journal.leansOnGlimpses(text));
	/** Runs one call of a round, unless it repeats an earlier one or no room is left for its result. */
	const answerCall = async (call: ToolCall, index: number): Promise<ToolOutcome> => {
		const signature = `${call.name}:${JSON.stringify(call.arguments)}`;
		const left = room();
		if (index >= MAX_CALLS_PER_ROUND) {
			return { status: null, content: "Too many calls at once; this one was not run. Ask again if you still need it." };
		}
		if (asked.has(signature)) {
			return { status: null, content: "This call was already answered above. Use that result, or try something else." };
		}
		if (left < MIN_RESULT_TOKENS * CHARS_PER_TOKEN) {
			full = true;
			return { status: null, content: "There is no room left to read more. Answer from the notes above." };
		}
		asked.add(signature);
		looked = true;
		return journal.run(call, left);
	};
	const finish = (text: string): ToolRunResult => {
		const notes = journal.sources(text);
		return {
			text,
			sources: notes.map(({ key, path, link }) => ({ key, path, link })),
			range: notes.length ? { from: notes[0].key, to: notes[notes.length - 1].key } : null,
		};
	};

	for (let round = 0; round < MAX_ROUNDS && !full; round++) {
		const nudge = nudgeFor();
		let sent: { result: ChatResult; streamed: boolean };
		try {
			sent = await send(TOOLS, nudge === null, nudge !== null && sendsBack(nudge, ""));
		} catch (error) {
			// A round that ends without a word or a call, as Gemma 4's sometimes
			// do, leaves the answer to the request without tools below.
			if (error instanceof ProviderError && error.kind === "failed") break;
			throw error;
		}
		const { result, streamed } = sent;
		const calls = result.toolCalls.length ? result.toolCalls : callsInText(result.text);
		if (calls.length) {
			if (streamed) options.onReset();
			// Calls written out as text are passed back as calls, not as that text.
			messages.push({ role: "assistant", content: result.toolCalls.length ? result.text : "", toolCalls: calls });
			for (const [index, call] of calls.entries()) {
				const outcome = await answerCall(call, index);
				if (outcome.status) options.onStatus(outcome.status);
				// Not after excerpts and lists alone, which end by saying what to read: the answer is not due yet.
				const due = index === calls.length - 1 && journal.read.size > 0;
				messages.push({ role: "tool", content: `${outcome.content}${due ? task : ""}`, toolName: call.name });
			}
			if (options.onSources) {
				const { sources, range } = finish("");
				options.onSources(sources, range);
			}
			continue;
		}
		if (!hasText(result.text)) {
			if (streamed) options.onReset();
			break;
		}
		if (nudge === null || !sendsBack(nudge, result.text)) {
			// Held back in case it was sent back: the card gets it whole.
			if (!streamed) options.onText(result.text);
			return finish(result.text);
		}
		// Neither streamed nor kept: the model never sees it again.
		nudged.add(nudge);
		messages.push({ role: "user", content: nudge });
	}

	messages.push({ role: "user", content: fill(`${ANSWER_NOW} ${question}\n\n${format}\n\n${REMINDER}`) });
	const { result, streamed } = await send(undefined, true);
	if (!hasText(result.text)) {
		if (streamed) options.onReset();
		throw new ProviderError("failed", "The model finished without writing an answer. Try again, or choose another model.");
	}
	return finish(result.text);
}
