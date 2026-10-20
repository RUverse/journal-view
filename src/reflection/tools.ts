import { getAllTags } from "obsidian";
import type { TFile } from "obsidian";
import { normalizeFilterTag } from "../filter";
import type JournalViewPlugin from "../main";
import { createMoment } from "../moment";
import type { Moment } from "../moment";
import { DAY_KEY_FORMAT } from "../noteIndex";
import {
	ANSWER_TOKENS,
	CHARS_PER_TOKEN,
	ESTIMATE_MARGIN,
	MONTHS,
	contextLimit,
	estimateTokens,
	formatNote,
	longDate,
	notesInScope,
	onThisDay,
	propertiesOf,
	propertyLine,
	readNote,
	spreadEvenly,
} from "./context";
import type { ReadNote, ReflectionSource, ScopeRange } from "./context";
import { QUESTION_FORMAT, REMINDER } from "./presets";
import { ProviderError } from "./provider";
import type { ChatMessage, ChatResult, ModelInfo, ReflectionProvider, ToolCall, ToolDefinition } from "./provider";

/*
 * The tools, their descriptions, the prompts and the loop were tuned against
 * local models with scripts/reflection-tools-spike.mjs, which mirrors this
 * file; change them there first.
 */

/** What a question the model answers with tools needs. */
export interface ToolRunOptions {
	plugin: JournalViewPlugin;
	provider: ReflectionProvider;
	/** The model's name and what it supports; it has to list `tools`. */
	model: ModelInfo;
	/** The reader's question. */
	question: string;
	/** The day the reflection belongs to. */
	today: Moment;
	/** The Maximum context setting, in tokens, and where links are written from. */
	maxContext: number;
	sourcePath: string;
	signal: AbortSignal;
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
	onSources?: (sources: ReflectionSource[], range: ScopeRange | null) => void;
}

export interface ToolRunResult {
	text: string;
	/**
	 * Every note the tools passed the model whole, and any it saw only in a
	 * list or an excerpt that the answer cites, oldest first.
	 */
	sources: ReflectionSource[];
	/** The days those notes span, or null when it read none. */
	range: ScopeRange | null;
}

/** Rounds that may call tools, before the model is asked for its answer. */
const MAX_ROUNDS = 6;
/** Calls answered in one round; the rest are told to ask again. */
const MAX_CALLS_PER_ROUND = 8;
/** Kept free after a tool result, for the next call and its arguments. */
const ROUND_RESERVE = 512;
/** Below this, a tool result is not worth sending, and the model is told to answer. */
const MIN_RESULT_TOKENS = 256;
/** Added per message for the chat template's own markup. */
const MESSAGE_OVERHEAD = 16;
/** A list of more notes than this is given by month instead. */
const MAX_LISTED_NOTES = 120;
/** The most notes one read considers; a longer range is thinned before anything is read. */
const MAX_READ_CANDIDATES = 300;
/** Characters of a note's opening, in a list. */
const PREVIEW_LENGTH = 90;
/** Notes a search shows, the excerpts of each, and the characters around each match. */
const MAX_SEARCH_NOTES = 30;
const EXCERPTS_PER_NOTE = 2;
const EXCERPT_BEFORE = 90;
const EXCERPT_AFTER = 150;
/** Notes read at once, between checks that the run has not been stopped. */
const READ_BATCH = 32;
/** Values held by at least this share of the journal's notes are left out of each note's properties. */
const SHARED_SHARE = 0.9;

const DATE_ARGUMENT = "written YYYY-MM-DD";

/**
 * The tools a model is offered. Their descriptions say when each is worth
 * calling; the results then say what to call next, which small models follow
 * far better than any instruction up front.
 */
const TOOLS: ToolDefinition[] = [
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
		name: "read_journal",
		description:
			"Read the notes in a range of days in full, oldest first, each under a heading with the link to cite it by. A long range may not fit; read a few weeks at a time, or only the notes with a tag.",
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
	{
		name: "search_journal",
		description:
			"Find the notes that mention a word or phrase, with a short excerpt around each mention, oldest first. Ignores case and matches the start of words, so run finds running and runs. Use it to find when something came up.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "A word or short phrase, such as a name, a place or an activity." },
				from: { type: "string", description: `The first day to search, ${DATE_ARGUMENT}. Optional.` },
				to: { type: "string", description: `The last day to search, ${DATE_ARGUMENT}. Optional.` },
			},
			required: ["query"],
		},
	},
];

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

/**
 * The rules of presets.ts's `SYSTEM_PROMPT`, for a model that reads through
 * tools: it has to look before it answers, and read in full rather than
 * answer from excerpts. `{exampleLink}` becomes the latest note's link.
 */
const TOOLS_SYSTEM_PROMPT = `You answer questions about someone's private journal, which you can only see by reading it with the tools.

- Before you answer, look: search or list the journal to find the notes the question needs, then read them in full. Excerpts and lists alone are too thin to answer from. Write dates as YYYY-MM-DD.
- Ground every point in specific notes, and cite each one with the exact link shown in its heading or line in the tool results, such as {exampleLink}.
- When the notes do not answer the question, say so instead of filling the gap.
- No praise, no generic advice, no therapy-speak.
- Write to the reader in the second person, in the language their notes are written in.
- Keep it to about 150–300 words unless the question asks otherwise.
- Never mention the tools, or suggest reading more: answer from what you have read.`;

/** After the question, in place of presets.ts's `REMINDER`, since the notes come later. */
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
 * which miss what the notes around them say: small models otherwise answer
 * from the first excerpts they get. Not after a search that found nothing,
 * when the answer cites nothing: sent back after saying that no note
 * mentions Lisbon, `qwen3:8b` read the whole journal and found a dream about it.
 */
const READ_FIRST =
	"Excerpts and lists are too thin to answer from. Read the notes that matter in full with read_journal first, then answer.";

/** Asks for the answer once the tools are taken away, followed by the question again. */
const ANSWER_NOW = "Answer my question now, from the notes above.";

/** A note the tools can reach: one the journal's filters let through, up to the run's day. */
interface JournalNote extends Omit<ReadNote, "body"> {
	file: TFile;
	/** Its tags as filters compare them, such as `work` or `family/mina`. */
	tags: string[];
}

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

const pad = (value: number) => String(value).padStart(2, "0");

/** A day as a key, or null when it does not exist, such as 31 February. */
function keyOf(year: number, month: number, day: number): string | null {
	const date = new Date(year, month - 1, day);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
	return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

/**
 * Reads a date argument: `YYYY-MM-DD`, or a date and time starting with one.
 * Given a year, a month and day alone, `MM-DD`, fall in it. The error says
 * how to call the tool again, which small models need spelled out.
 */
function parseDate(text: string, name: string, tool: string, year: number | null = null): { key: string } | { error: string } {
	const example = `such as "${name}": "2026-10-05"`;
	if (!text) return { error: `"${name}" is missing. Call ${tool} again with a date ${DATE_ARGUMENT}, ${example}.` };
	const full = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
	const short = year === null ? null : /^-{0,2}(\d{1,2})-(\d{1,2})$/.exec(text);
	const key = full
		? keyOf(Number(full[1]), Number(full[2]), Number(full[3]))
		: short && year !== null
			? keyOf(year, Number(short[1]), Number(short[2]))
			: null;
	if (key) return { key };
	return { error: `"${name}" must be a date ${DATE_ARGUMENT}, not "${text}". Call ${tool} again with one, ${example}.` };
}

/** "19 October", "Oct 19" or "October 19, 2024", in `year` unless it names one. */
function monthDayOf(text: string, year: number): string | null {
	const match =
		/^(?:(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)|([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?)\.?,?(?:\s+(\d{4}))?$/i.exec(text);
	if (!match) return null;
	const name = (match[2] ?? match[3]).toLowerCase();
	const month = MONTHS.findIndex((candidate) => name.length >= 3 && candidate.toLowerCase().startsWith(name));
	if (month === -1) return null;
	return keyOf(match[5] ? Number(match[5]) : year, month + 1, Number(match[1] ?? match[4]));
}

/** "5 Oct", in the app's language as the card's other lines are, with the year when it is not this one. */
function shortDate(key: string, withYear: boolean): string {
	return createMoment(key, DAY_KEY_FORMAT, true).format(withYear ? "D MMM YYYY" : "D MMM");
}

/** "5 Oct – 19 Oct", with years when the range leaves this year. */
function spanLabel(from: string, to: string, today: string): string {
	const withYear = from.slice(0, 4) !== today.slice(0, 4) || to.slice(0, 4) !== today.slice(0, 4);
	return from === to ? shortDate(from, withYear) : `${shortDate(from, withYear)} – ${shortDate(to, withYear)}`;
}

/** Items joined with commas, the long tail counted rather than written out. */
function listOf(items: readonly string[], max = 20): string {
	if (items.length <= max) return items.join(", ");
	return `${items.slice(0, max).join(", ")} and ${items.length - max} more, up to ${items[items.length - 1]}`;
}

/** A note's first words, for a list, without its headings or list markers. */
function preview(body: string): string {
	const text = body
		.replace(/^#+\s+.*$/gm, " ")
		.replace(/^\s*[-*+]\s+(\[.\]\s+)?/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH).replace(/\s+\S*$/, "")}…` : text;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A word cut back to what its forms share, so running finds run and runs, and worries finds worried. */
function stemOf(word: string): string {
	const lower = word.toLocaleLowerCase().replace(/['’]s$/, "");
	let stem = lower;
	if (lower.length > 5 && lower.endsWith("ing")) stem = lower.slice(0, -3);
	else if (lower.length > 4 && /ie[sd]$/.test(lower)) return lower.slice(0, -3);
	else if (lower.length > 4 && lower.endsWith("ed")) stem = lower.slice(0, -2);
	else if (lower.length > 4 && /(s|x|z|ch|sh)es$/.test(lower)) return lower.slice(0, -2);
	else if (lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1);
	// The consonant that -ing and -ed doubled: runn, stopp.
	return stem !== lower && /([b-df-hj-km-np-rtv-z])\1$/.test(stem) ? stem.slice(0, -1) : stem;
}

const wordsOf = (phrase: string): string[] => phrase.match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * A phrase at the start of a word, ignoring case, each word in any of its
 * forms. The character before it is matched rather than looked behind at,
 * since lookbehind is missing on iOS before 16.4.
 */
function phrasePattern(phrase: string): RegExp {
	const body = wordsOf(phrase)
		.map((word) => `${escapeRegExp(stemOf(word))}[\\p{L}\\p{N}'’]*`)
		.join("[^\\p{L}\\p{N}]+");
	return new RegExp(`(^|[^\\p{L}\\p{N}_])(${body})`, "giu");
}

/** What a query asks for: alternatives split by OR, `|` or commas, as models write them. */
function alternativesOf(query: string): string[] {
	return query
		.split(/\s+OR\s+|\||,/)
		.map((part) => part.trim())
		.filter((part) => wordsOf(part).length > 0);
}

/** Up to `limit` stretches of `body` around what `patterns` match, as one line each. */
function excerptsOf(body: string, patterns: readonly RegExp[], limit: number): string[] {
	const text = body.replace(/\s+/g, " ");
	const found: number[] = [];
	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text)) && found.length < 20) found.push(match.index + match[1].length);
	}
	found.sort((left, right) => left - right);
	const excerpts: string[] = [];
	let end = -1;
	for (const index of found) {
		if (index < end || excerpts.length >= limit) continue;
		let start = Math.max(0, index - EXCERPT_BEFORE);
		let stop = Math.min(text.length, index + EXCERPT_AFTER);
		if (start > 0) start = text.indexOf(" ", start) + 1 || start;
		if (stop < text.length) {
			const space = text.lastIndexOf(" ", stop);
			if (space > index) stop = space;
		}
		excerpts.push(`${start > 0 ? "…" : ""}${text.slice(start, stop).trim()}${stop < text.length ? "…" : ""}`);
		end = stop;
	}
	return excerpts;
}

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
	return link.startsWith("[[") && link.endsWith("]]") ? link.slice(2, -2) : link;
}

/** True when `text` cites a note, by its link or by its link text alone, which `repairCitations` links. */
function cites(text: string, note: JournalNote): boolean {
	return text.includes(linkText(note.link));
}

/**
 * The journal as a run's tools read it: every note the filters let through,
 * up to the run's day, and what the model has been shown of each. Note
 * bodies come through `FindCorpus` for lists and searches, which the run
 * keeps for its length, and through `readNote` when passed whole, so they
 * are formatted exactly as a preset's are.
 */
class JournalReader {
	/** The run's day, `YYYY-MM-DD`: nothing after it is read. */
	readonly today: string;
	readonly notes: JournalNote[];
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
	private readonly first: string;

	constructor(
		private readonly plugin: JournalViewPlugin,
		day: Moment,
		private readonly sourcePath: string,
		private readonly signal: AbortSignal,
	) {
		const { app } = plugin;
		this.today = day.format(DAY_KEY_FORMAT);
		const earliest = plugin.index.range()?.first ?? this.today;
		const from = earliest < this.today ? earliest : this.today;
		// The journal's own filters, as a preset's notes are chosen.
		const { notes } = notesInScope(plugin, { kind: "range", from, to: this.today }, day);
		this.notes = notes.map(({ key, file }) => {
			const cache = app.metadataCache.getFileCache(file);
			return {
				key,
				file,
				path: file.path,
				link: `[[${app.metadataCache.fileToLinktext(file, sourcePath)}]]`,
				name: file.basename,
				properties: propertiesOf(cache?.frontmatter),
				tags: [...new Set((getAllTags(cache ?? {}) ?? []).map(normalizeFilterTag))],
			};
		});
		this.first = this.notes[0]?.key ?? this.today;
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

	/** Runs one call, whose arguments are as the model wrote them. */
	async run(call: ToolCall, room: number): Promise<ToolOutcome> {
		const args = call.arguments;
		switch (call.name) {
			case "list_journal":
				return this.list(args, room);
			case "read_journal":
				return this.readRange(args, room);
			case "on_this_day":
				return this.onThisDay(args, room);
			case "search_journal":
				return this.search(args, room);
			default:
				return {
					status: null,
					content: `There is no tool named "${call.name}". The tools are list_journal, read_journal, on_this_day and search_journal.`,
				};
		}
	}

	/** The notes `cited` mentions or that were read whole, oldest first, as the run's sources. */
	sources(cited: string): JournalNote[] {
		const notes = [...this.read.values()];
		for (const note of this.glimpsed.values()) if (cites(cited, note)) notes.push(note);
		return notes.sort((left, right) => left.key.localeCompare(right.key) || left.path.localeCompare(right.path));
	}

	private async list(args: Record<string, unknown>, room: number): Promise<ToolOutcome> {
		const range = this.range(args, "list_journal", true);
		if ("error" in range) return { status: null, content: range.error };
		const { from, to, notices } = range;
		const notes = this.notesIn(from, to);
		const withYear = this.withYear(from, to);
		const span = `${longDate(from, withYear)} to ${longDate(to, withYear)}`;
		const status = `Listing ${spanLabel(from, to, this.today)}`;
		if (!notes.length) return { status, content: [...notices, `There are no notes from ${span}.`].join("\n") };
		if (notes.length <= MAX_LISTED_NOTES) {
			const lines = await this.inBatches(notes, async (note) => {
				const [body, count] = await Promise.all([
					this.plugin.findCorpus.read(note.file),
					this.plugin.statistics.count(note.file, () => !this.signal.aborted),
				]);
				const properties = propertyLine({ ...note, body: "" }, this.shared);
				const parts = [note.link, longDate(note.key, withYear)];
				if (count?.status === "ready") parts.push(plural(count.words, "word"));
				if (properties) parts.push(properties);
				const opening = body ? preview(body) : "";
				return `- ${parts.join(" · ")}${opening ? `: ${opening}` : ""}`;
			});
			const content = [
				...notices,
				`${plural(notes.length, "note")} from ${span}, oldest first. Read them with read_journal, or find words in them with search_journal.`,
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
		const tag = normalizeFilterTag(stringArgument(args.tag));
		const withYear = this.withYear(from, to);
		const span = `${longDate(from, withYear)} to ${longDate(to, withYear)}`;
		const status = `Reading ${spanLabel(from, to, this.today)}${tag ? ` · #${tag}` : ""}`;
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
		const year = Number(this.today.slice(0, 4));
		const parsed = asked ? parseDate(asked, "date", "on_this_day", year) : { key: this.today };
		// Models often write the date out, "19 October": read it, or fall back to today.
		const key = "key" in parsed ? parsed.key : monthDayOf(asked, year);
		const notices: string[] = key ? [] : [`"${asked}" is not a date written YYYY-MM-DD, so today's date was used.`];
		// Only the month and day count: models pass the first year as often as today.
		const date = key ?? this.today;
		const day = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
		const status =
			date.slice(5) === this.today.slice(5)
				? "Looking at this date in earlier years"
				: `Looking at ${shortDate(date, false)} in earlier years`;
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

	private async search(args: Record<string, unknown>, room: number): Promise<ToolOutcome> {
		this.searches++;
		const alternatives = alternativesOf(stringArgument(args.query));
		if (!alternatives.length) {
			return {
				status: null,
				content: `"query" is empty. Call search_journal again with a word or short phrase to find, such as a name.`,
			};
		}
		const range = this.range(args, "search_journal", true);
		if ("error" in range) return { status: null, content: range.error };
		const { from, to, notices } = range;
		const withYear = this.withYear(from, to);
		const span = `${longDate(from, withYear)} to ${longDate(to, withYear)}`;
		const quoted = `"${alternatives.join('" or "')}"`;
		const status = `Searching for ${quoted}`;
		const patterns = alternatives.map(phrasePattern);
		// A note tagged `running` is about running, whatever its words.
		const tagStems = alternatives
			.filter((part) => wordsOf(part).length === 1)
			.map((part) => stemOf(wordsOf(part)[0]))
			.filter((stem) => stem.length >= 3);
		const notes = this.notesIn(from, to);
		const bodies = await this.inBatches(notes, (note) => this.plugin.findCorpus.read(note.file));
		const matches = (body: string) =>
			patterns.some((pattern) => {
				pattern.lastIndex = 0;
				return pattern.test(body);
			});
		const hits: Array<{ note: JournalNote; body: string }> = [];
		for (const [index, note] of notes.entries()) {
			const body = bodies[index] ?? "";
			if (matches(body) || note.tags.some((tag) => tagStems.some((stem) => tag.startsWith(stem)))) {
				hits.push({ note, body });
			}
		}
		if (!hits.length) {
			return {
				status,
				content: [
					...notices,
					`No note from ${span} mentions ${quoted}. Try another word for it, or list_journal to see what the notes cover.`,
				].join("\n"),
			};
		}
		const first = hits[0].note.key;
		const last = hits[hits.length - 1].note.key;
		// Small models read on when told exactly what to call; the range between
		// the first and last mention holds what happened in between.
		const next =
			first === last
				? `To read it in full: read_journal with {"from": "${first}", "to": "${last}"}.`
				: `To follow it from first mention to last, read that range in full: read_journal with {"from": "${first}", "to": "${last}"}.`;
		const lineFor = ({ note, body }: { note: JournalNote; body: string }, limit: number) => {
			const excerpts = excerptsOf(body, patterns, limit);
			const text = excerpts.length ? excerpts.join(" ") : `(tagged) ${preview(body)}`;
			return `- ${note.link} · ${longDate(note.key, withYear)}: ${text}`;
		};
		const compose = (shown: readonly number[], limit: number) => {
			const left = hits.filter((_, index) => !shown.includes(index));
			const shownText = shown.length < hits.length ? `; ${shown.length} shown` : "";
			return [
				...notices,
				`${plural(hits.length, "note")} from ${span} ${hits.length === 1 ? "mentions" : "mention"} ${quoted}, oldest first${shownText}. These are only excerpts: read the notes that matter in full with read_journal before you answer.`,
				"",
				...shown.map((index) => lineFor(hits[index], limit)),
				...(left.length
					? [
							"",
							`Also mentioned, not shown for want of room: ${listOf(left.map(({ note }) => note.key))}. Search a shorter range to see them.`,
						]
					: []),
				"",
				next,
			].join("\n");
		};
		let limit = EXCERPTS_PER_NOTE;
		let count = Math.min(hits.length, MAX_SEARCH_NOTES);
		let content = compose(spreadEvenly(hits.length, count), limit);
		if (content.length > room) {
			limit = 1;
			content = compose(spreadEvenly(hits.length, count), limit);
		}
		while (count > 1 && content.length > room) {
			count--;
			content = compose(spreadEvenly(hits.length, count), limit);
		}
		for (const { note } of hits) this.hits.add(note.path);
		this.glimpse(spreadEvenly(hits.length, count).map((index) => hits[index].note));
		return { status, content };
	}

	/**
	 * Passes `notes` whole within `room` characters. Notes already passed are
	 * named rather than repeated. When the rest do not fit, whole notes are
	 * dropped evenly across them, keeping first the ones a search found, and
	 * the dropped ones are named as plain dates, not links, so the model can
	 * read them by a narrower range but not cite what it has not read.
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
		if (!unread.length) return `${already} Answer from them, or read another range.`;
		// A range of years is thinned before anything is read: far fewer fit.
		const fresh =
			unread.length > MAX_READ_CANDIDATES
				? this.prioritized(unread, MAX_READ_CANDIDATES).map((index) => unread[index])
				: unread;
		const read = await this.inBatches(fresh, (note) => readNote(this.plugin, note, this.sourcePath));
		const readable = fresh.filter((_, index) => read[index] !== null);
		const sections = read.filter((note): note is ReadNote => note !== null).map((note) => formatNote(note, withYear, this.shared));
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
					`Not shown, for want of room: ${listOf(left.map((note) => note.key))}. Read a shorter range, or search for what you need, to see them.`,
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
		const from = fromText || !optional ? parseDate(fromText, "from", tool) : { key: this.first };
		if ("error" in from) return from;
		const to = toText || !optional ? parseDate(toText, "to", tool) : { key: this.today };
		if ("error" in to) return to;
		const notices: string[] = [];
		let start = from.key;
		let end = to.key;
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

	/** Headings carry the year when the range leaves this year, as a preset's do when it spans two. */
	private withYear(from: string, to: string): boolean {
		return from.slice(0, 4) !== to.slice(0, 4) || to.slice(0, 4) !== this.today.slice(0, 4);
	}

	private glimpse(notes: readonly JournalNote[]): void {
		for (const note of notes) if (!this.read.has(note.path)) this.glimpsed.set(note.path, note);
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
 * Per property, the values held by nearly every note in the journal. A
 * preset leaves out what every note in its range shares; across a whole
 * journal one odd note would keep `type: daily` on every other, so nearly
 * every note is enough.
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
	const common = new Set([...(shared.get("tags") ?? [])].map(normalizeFilterTag));
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
 * listing, reading and searching notes, and this date over the years. Stops
 * offering tools after a few rounds and asks for the answer.
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
	const { plugin, provider, model, signal } = options;
	if (signal.aborted) throw aborted();
	const release = plugin.findCorpus.retain();
	try {
		const journal = new JournalReader(plugin, options.today, options.sourcePath, signal);
		const latest = journal.latest;
		if (!latest) throw new ProviderError("failed", "There are no notes to read yet");
		const fill = (text: string) => text.replace(/\{exampleLink\}/g, latest.link);
		const system = [
			fill(TOOLS_SYSTEM_PROMPT),
			"",
			// Also as the tools take dates, so ranges can be counted from it.
			`Today is ${longDate(journal.today, true)} (${journal.today}). The journal holds ${plural(journal.notes.length, "note")}, from ${longDate(journal.notes[0].key, true)} to ${longDate(latest.key, true)}.`,
		].join("\n");
		const messages: ChatMessage[] = [
			{ role: "system", content: system },
			{ role: "user", content: `${options.question}\n\n${QUESTION_FORMAT}\n\n${fill(TOOLS_REMINDER)}` },
		];

		// The whole context from the first round: changing it between rounds
		// would make Ollama load the model again each time.
		const limit = contextLimit(model.contextLength, options.maxContext);
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
				"The model's context is too small to read the journal through tools. Raise Maximum context, or pick the notes it reads.",
			);
		}

		/** One request; its text is streamed to the card only when `live`. */
		const send = async (tools: ToolDefinition[] | undefined, live: boolean) => {
			let streamed = false;
			const length = conversationLength(messages, tools);
			const result: ChatResult = await provider.chat({
				model: model.name,
				messages,
				numCtx: limit,
				signal,
				tools,
				onText: (delta) => {
					if (!live) return;
					streamed = true;
					options.onText(delta);
				},
			});
			if (result.promptTokens) ratio = Math.max(ratio, result.promptTokens / estimateTokens(length));
			return { result, streamed };
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
				sent = await send(TOOLS, nudge === null);
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
					messages.push({ role: "tool", content: outcome.content, toolName: call.name });
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

		messages.push({
			role: "user",
			content: `${ANSWER_NOW} ${options.question}\n\n${QUESTION_FORMAT}\n\n${fill(REMINDER)}`,
		});
		const { result, streamed } = await send(undefined, true);
		if (!hasText(result.text)) {
			if (streamed) options.onReset();
			throw new ProviderError("failed", "The model finished without writing an answer. Try again, or choose another model.");
		}
		return finish(result.text);
	} finally {
		release();
	}
}
