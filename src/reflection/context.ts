/*
 * What Reflection's prompts are built from: dates as the model reads them,
 * notes as it is shown them, the room a model's context leaves, and the
 * citations it writes back. Nothing here touches Obsidian, so the spike
 * (scripts/reflection-spike.mjs) runs it as it is.
 */

/** About four characters to a token, which came within 5% of Ollama's own count for English. */
export const CHARS_PER_TOKEN = 4;
/** Gemma counted more tokens than the estimate; the margin keeps a prompt from being cut. */
export const ESTIMATE_MARGIN = 1.1;
/** Room left for the answer once the prompt is in. */
export const ANSWER_TOKENS = 1024;
/** Assumed when the server does not say how much a model takes: Ollama's own default. */
const DEFAULT_CONTEXT = 8192;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const MONTHS = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
];

/** A note that was read; `link` is written as the model is told to cite it, such as `[[2026-10-05]]`. */
export interface ReflectionSource {
	key: string;
	path: string;
	link: string;
}

/** A span of days, as `YYYY-MM-DD` keys. */
export interface DayRange {
	from: string;
	to: string;
}

/** A note, once read and ready to format. */
export interface ReadNote extends ReflectionSource {
	/** The file name, which a property can restate. */
	name: string;
	body: string;
	properties: Map<string, string[]>;
}

/** A `YYYY-MM-DD` key as a local date. */
function dateOf(key: string): Date {
	return new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
}

const pad = (value: number) => String(value).padStart(2, "0");

/** A local date as a `YYYY-MM-DD` key. */
function keyOfDate(date: Date): string {
	return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A day as a key, or null when it does not exist, such as 31 February. */
export function dayKey(year: number, month: number, day: number): string | null {
	const date = new Date(year, month - 1, day);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
	return keyOfDate(date);
}

/** The day `days` after `key`, or before it when negative. */
export function addDays(key: string, days: number): string {
	const date = dateOf(key);
	date.setDate(date.getDate() + days);
	return keyOfDate(date);
}

/**
 * The day `months` before `key`; a day its month lacks becomes that month's
 * last, so a month before 31 March is the end of February.
 */
export function monthsBefore(key: string, months: number): string {
	const date = dateOf(key);
	const day = date.getDate();
	date.setDate(1);
	date.setMonth(date.getMonth() - months);
	const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
	date.setDate(Math.min(day, last));
	return keyOfDate(date);
}

/** The last day of a month, as a key. */
export function monthEnd(year: number, month: number): string {
	return keyOfDate(new Date(year, month, 0));
}

/**
 * "Monday, 5 October", in English whatever the app's language: the prompts
 * are English, and they were tuned with dates written this way.
 */
export function longDate(key: string, withYear: boolean): string {
	const date = dateOf(key);
	const text = `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]}`;
	return withYear ? `${text} ${date.getFullYear()}` : text;
}

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** The same month and day as `today`; on 29 February, the 28th stands in for years without one. */
export function onThisDay(key: string, today: string): boolean {
	const monthDay = today.slice(5);
	if (key.slice(5) === monthDay) return true;
	return monthDay === "02-29" && key.slice(5) === "02-28" && !isLeapYear(Number(key.slice(0, 4)));
}

/** Pushes a note's own headings below the `###` that introduces it, so a `## Log` cannot read as a new note. */
export function demoteHeadings(body: string): string {
	return body.replace(/^(#{1,3})(?=[ \t])/gm, (hashes: string) => "#".repeat(hashes.length + 3));
}

/** A property's values as text: lists item by item, leaving out nested objects and empty values. */
function propertyValues(value: unknown): string[] {
	const items: unknown[] = Array.isArray(value) ? value : [value];
	const values: string[] = [];
	for (const item of items) {
		if (typeof item === "string" && item.trim()) values.push(item.trim());
		else if (typeof item === "number" || typeof item === "boolean") values.push(String(item));
	}
	return values;
}

/** A note's properties as text, by name, from its parsed frontmatter. */
export function propertiesOf(frontmatter: Record<string, unknown> | undefined): Map<string, string[]> {
	const properties = new Map<string, string[]>();
	if (!frontmatter) return properties;
	for (const [key, value] of Object.entries(frontmatter)) {
		const values = propertyValues(value);
		if (values.length) properties.set(key, values);
	}
	return properties;
}

/** True when a property only says which day the note is: its date, a time on it, its name, or its weekday. */
function restatesDate(value: string, note: Pick<ReadNote, "key" | "name">): boolean {
	if (value === note.key || value === note.name) return true;
	if (value.startsWith(`${note.key}T`) || value.startsWith(`${note.key} `)) return true;
	return value.toLowerCase() === WEEKDAYS[dateOf(note.key).getDay()].toLowerCase();
}

/**
 * One line of the note's properties, such as `mood: awful · tags: work`.
 * Moods are the best signal a week's review has for energy; what every note
 * shares, or what restates the date, tells the model nothing.
 */
export function propertyLine(note: Pick<ReadNote, "key" | "name" | "properties">, shared: Map<string, Set<string>>): string {
	const parts: string[] = [];
	for (const [key, values] of note.properties) {
		const kept = values.filter((value) => !restatesDate(value, note) && !shared.get(key)?.has(value));
		if (kept.length) parts.push(`${key}: ${kept.join(", ")}`);
	}
	return parts.join(" · ");
}

/** A note under a heading carrying the exact link to cite it by. */
export function formatNote(note: ReadNote, withYear: boolean, shared: Map<string, Set<string>>): string {
	const properties = propertyLine(note, shared);
	const heading = `### ${note.link} · ${longDate(note.key, withYear)}`;
	return `${heading}\n${properties ? `${properties}\n` : ""}\n${note.body}`.trimEnd();
}

/**
 * The indexes of `count` of `length` notes, spread evenly across the range
 * and always keeping the first and last, so dropping notes thins the whole
 * range rather than cutting off its start. One note is the latest.
 */
export function spreadEvenly(length: number, count: number): number[] {
	if (count >= length) return Array.from({ length }, (_, index) => index);
	if (count <= 1) return length ? [length - 1] : [];
	const picked: number[] = [];
	for (let index = 0; index < count; index++) picked.push(Math.round((index * (length - 1)) / (count - 1)));
	return picked;
}

export const estimateTokens = (characters: number) => Math.ceil(characters / CHARS_PER_TOKEN);

/** The context to work in: the model's own limit, capped by the Maximum context setting. */
export function contextLimit(contextLength: number | null, maxContext: number): number {
	const model = contextLength !== null && contextLength > 0 ? contextLength : DEFAULT_CONTEXT;
	return Number.isFinite(maxContext) && maxContext > 0 ? Math.min(model, maxContext) : model;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The link text inside `[[…]]`. */
function linkText(link: string): string {
	return link.startsWith("[[") && link.endsWith("]]") ? link.slice(2, -2) : link;
}

/**
 * Mends citations as models write them before they are rendered: a link
 * holding several notes, `[[2024-10-19, 2025-10-19]]` or
 * `[[2024-10-19], [2025-10-19]]`, becomes one link per note, and a bare
 * `2026-10-05` that is exactly a note's link text becomes its link, unless
 * its own link follows it, as in `on 2026-10-05 [[2026-10-05]]`. Only notes
 * that were read are linked; anything else, including links to notes that
 * were not read and text in code, is left as written.
 */
export function repairCitations(text: string, sources: readonly ReflectionSource[]): string {
	const targets = new Set(sources.map((source) => linkText(source.link)).filter(Boolean));
	if (!targets.size) return text;
	// Gemma writes several notes as `[[2026-07-25], [2026-08-14]]`: one link per note.
	text = text.replace(/\[\[[^[\]\n]+\](?:\s*[,;]\s*\[[^[\]\n]+\])+\]/g, (match: string) => {
		const parts = Array.from(match.slice(1, -1).matchAll(/\[([^[\]\n]+)\]/g), (part) => part[1].trim());
		return parts.every((part) => targets.has(part)) ? parts.map((part) => `[[${part}]]`).join(", ") : match;
	});
	// Longest first, so `2026-10-05 Birthday` is not linked as `2026-10-05`.
	const names = [...targets].sort((left, right) => right.length - left.length).map(escapeRegExp);
	const pattern = new RegExp(
		[
			// Code is left alone.
			"`[^`\\n]+`",
			// A link, perhaps holding several notes.
			"\\[\\[([^\\]\\n]*)\\]\\]",
			// A note's link text standing on its own, not inside a word, path, tag or
			// Markdown link. The character before it is matched and written back,
			// since lookbehind is missing on iOS before 16.4.
			`(^|[^\\p{L}\\p{N}_/#\\[\\-])(${names.join("|")})(?![\\p{L}\\p{N}_\\]\\-])`,
		].join("|"),
		"gu",
	);
	const repair = (
		match: string,
		inner: string | undefined,
		before: string | undefined,
		bare: string | undefined,
		offset: number,
		whole: string,
	): string => {
		if (bare !== undefined) {
			// Its own link next, perhaps in brackets: `2026-10-05 ([[2026-10-05]])`.
			const after = whole.slice(offset + match.length).replace(/^[\s(),;:]*/, "");
			return after.startsWith(`[[${bare}]]`) ? match : `${before ?? ""}[[${bare}]]`;
		}
		if (inner === undefined || targets.has(inner)) return match;
		const parts = inner.split(/[,;]/).map((part) => part.trim());
		if (parts.length < 2 || !parts.every((part) => targets.has(part))) return match;
		return parts.map((part) => `[[${part}]]`).join(", ");
	};
	return text.replace(pattern, repair);
}
