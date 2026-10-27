import { TFile } from "obsidian";
import type { FrontMatterCache } from "obsidian";
import type JournalViewPlugin from "../main";
import type { Moment } from "../moment";
import { editorBody } from "../noteBody";
import { DAY_KEY_FORMAT } from "../noteIndex";
import { conversationMessages } from "./conversation";
import type { Conversation } from "./conversation";
import { QUESTION_FORMAT, REMINDER, SYSTEM_PROMPT } from "./presets";
import type { ReflectionRequest, ReflectionScope } from "./presets";
import { ProviderError } from "./provider";
import type { ChatMessage } from "./provider";

/** About four characters to a token, which came within 5% of Ollama's own count for English. */
export const CHARS_PER_TOKEN = 4;
/** Gemma counted more tokens than the estimate; the margin keeps a prompt from being cut. */
export const ESTIMATE_MARGIN = 1.1;
/** Room left for the answer once the prompt is in. */
export const ANSWER_TOKENS = 1024;
/** Context sizes are asked for in steps, so similar prompts reuse a loaded model. */
const CONTEXT_STEP = 2048;
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

/** The days a reflection reads, as `YYYY-MM-DD` keys. */
export interface ScopeRange {
	from: string;
	to: string;
}

export interface ReflectionContext {
	messages: ChatMessage[];
	/** The days read: for this day over the years, from the earliest year with a note. */
	range: ScopeRange;
	/** The notes passed, oldest first. */
	sources: ReflectionSource[];
	/** The notes in range before any were dropped to fit. */
	total: number;
	/** Estimated prompt tokens, to check against the count the server reports. */
	estimate: number;
	numCtx: number;
}

/** A note in scope, once read and ready to format. */
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

/**
 * The days a scope reads. A range of days counts today unless it ends
 * before today. This day over the years is given as today alone: which
 * earlier years it reaches depends on the notes, and `buildContext` reports
 * the range it read. So is a scope the model chooses, which no range fixes.
 */
export function scopeRange(scope: ReflectionScope, today: Moment): ScopeRange {
	const end = today.clone().startOf("day");
	if (scope.kind === "this-day" || scope.kind === "model") {
		const key = end.format(DAY_KEY_FORMAT);
		return { from: key, to: key };
	}
	if (scope.kind === "range") {
		return scope.from <= scope.to ? { from: scope.from, to: scope.to } : { from: scope.to, to: scope.from };
	}
	if (scope.beforeToday) end.subtract(1, "days");
	const days = Number.isFinite(scope.days) ? Math.max(1, Math.floor(scope.days)) : 1;
	return { from: end.clone().subtract(days - 1, "days").format(DAY_KEY_FORMAT), to: end.format(DAY_KEY_FORMAT) };
}

/**
 * Every note in scope that the journal's filters let through, oldest first.
 * Notes are judged one by one, as the journal judges them within a day, so a
 * rule such as excluding `#private` keeps those notes from the model.
 */
export function notesInScope(
	plugin: JournalViewPlugin,
	scope: ReflectionScope,
	today: Moment,
): { range: ScopeRange; notes: Array<{ key: string; file: TFile }> } {
	plugin.filteredIndex.ensureCurrent();
	const range = scopeRange(scope, today);
	const wanted =
		scope.kind === "this-day" ? (key: string) => onThisDay(key, range.to) : (key: string) => key >= range.from;
	const notes: Array<{ key: string; file: TFile }> = [];
	for (const key of plugin.index.keys()) {
		if (key > range.to) break;
		if (!wanted(key)) continue;
		for (const path of plugin.index.pathsFor(key)) {
			const file = plugin.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile && plugin.filteredIndex.matchesPath(path)) notes.push({ key, file });
		}
	}
	return { range, notes };
}

/**
 * How much a scope would read, for the menu: the notes, and the words in
 * them. Counts come from the statistics cache, which most notes are already in.
 */
export async function summarizeScope(
	plugin: JournalViewPlugin,
	scope: ReflectionScope,
	today: Moment,
): Promise<{ notes: number; words: number }> {
	const { notes } = notesInScope(plugin, scope, today);
	const counts = await Promise.all(notes.map(({ file }) => plugin.statistics.count(file, () => true)));
	let words = 0;
	for (const count of counts) if (count?.status === "ready") words += count.words;
	return { notes: notes.length, words };
}

/** Pushes a note's own headings below the `###` that introduces it, so a `## Log` cannot read as a new note. */
function demoteHeadings(body: string): string {
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

export function propertiesOf(frontmatter: FrontMatterCache | undefined): Map<string, string[]> {
	const properties = new Map<string, string[]>();
	if (!frontmatter) return properties;
	for (const [key, value] of Object.entries(frontmatter)) {
		const values = propertyValues(value);
		if (values.length) properties.set(key, values);
	}
	return properties;
}

/** True when a property only says which day the note is: its date, a time on it, its name, or its weekday. */
function restatesDate(value: string, note: ReadNote): boolean {
	if (value === note.key || value === note.name) return true;
	if (value.startsWith(`${note.key}T`) || value.startsWith(`${note.key} `)) return true;
	return value.toLowerCase() === WEEKDAYS[dateOf(note.key).getDay()].toLowerCase();
}

/** Per property, the values every note holds, such as `type: daily` or the tag `journal`. */
function sharedValues(notes: readonly ReadNote[]): Map<string, Set<string>> {
	const shared = new Map<string, Set<string>>();
	// A single note shares everything with itself, which would leave it no properties.
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
		const everywhere = [...byValue].filter(([, count]) => count === notes.length).map(([value]) => value);
		if (everywhere.length) shared.set(key, new Set(everywhere));
	}
	return shared;
}

/**
 * One line of the note's properties, such as `mood: awful · tags: work`.
 * Moods are the best signal a week's review has for energy; what every note
 * shares, or what restates the date, tells the model nothing.
 */
export function propertyLine(note: ReadNote, shared: Map<string, Set<string>>): string {
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

export async function readNote(
	plugin: JournalViewPlugin,
	note: { key: string; file: TFile },
	sourcePath: string,
): Promise<ReadNote | null> {
	const { app } = plugin;
	try {
		const content = await app.vault.cachedRead(note.file);
		return {
			key: note.key,
			path: note.file.path,
			link: `[[${app.metadataCache.fileToLinktext(note.file, sourcePath)}]]`,
			name: note.file.basename,
			// The properties are passed as one line below the heading, not as YAML.
			body: demoteHeadings(editorBody(content).trim()),
			properties: propertiesOf(app.metadataCache.getFileCache(note.file)?.frontmatter),
		};
	} catch (error) {
		console.warn(`Journal View: could not read ${note.file.path} for a reflection`, error);
		return null;
	}
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

/**
 * The conversation that asks for a reflection over fixed notes: the notes in
 * its scope, oldest first, each under a heading with the link to cite it by,
 * then the request, the shape of its answer, and a reminder of the rules.
 * When the notes do not fit the model's context, whole notes are dropped
 * evenly across the range. Throws `ProviderError("failed")` when no note in
 * scope could be read, since a model given none would invent them.
 *
 * With `followUp`, the reflection's answer and its follow-ups come after the
 * request, then the new question; the notes make room for them.
 */
export async function buildContext(
	plugin: JournalViewPlugin,
	preset: Pick<ReflectionRequest, "scope" | "prompt" | "format">,
	today: Moment,
	limits: { contextLength: number | null; maxContext: number; sourcePath: string },
	followUp?: { conversation: Conversation; question: string },
): Promise<ReflectionContext> {
	const { range: scoped, notes: inScope } = notesInScope(plugin, preset.scope, today);
	const read = await Promise.all(inScope.map((note) => readNote(plugin, note, limits.sourcePath)));
	const notes = read.filter((note): note is ReadNote => note !== null);
	const thisDay = preset.scope.kind === "this-day";
	if (!notes.length) {
		const where = thisDay ? "this date" : `${longDate(scoped.from, false)} to ${longDate(scoped.to, false)}`;
		throw new ProviderError("failed", `There are no notes to read from ${where}`);
	}

	const range: ScopeRange = { from: thisDay ? notes[0].key : scoped.from, to: scoped.to };
	const withYear = range.from.slice(0, 4) !== range.to.slice(0, 4);
	const todayKey = today.format(DAY_KEY_FORMAT);
	// Models cannot count back from today, so the cut-off date is written in.
	const twoWeeksAgo = longDate(today.clone().startOf("day").subtract(14, "days").format(DAY_KEY_FORMAT), withYear);
	const fill = (text: string, exampleLink: string) =>
		text.replace(/\{(exampleLink|twoWeeksAgo)\}/g, (_match, name: string) =>
			name === "exampleLink" ? exampleLink : twoWeeksAgo,
		);
	const system = (exampleLink: string) =>
		`${fill(SYSTEM_PROMPT, exampleLink)}\n\nToday is ${longDate(todayKey, true)}.`;
	const task = (exampleLink: string) =>
		fill(`${preset.prompt}\n\n${preset.format}\n\n${REMINDER}`, exampleLink);
	const rangeText = thisDay
		? "this date in every earlier year, and today"
		: `${longDate(range.from, withYear)} to ${longDate(range.to, withYear)}`;
	const header = (count: number) =>
		`My journal notes from ${rangeText}, oldest first (${count} of ${notes.length} notes):`;
	const shared = sharedValues(notes);
	const sections = notes.map((note) => formatNote(note, withYear, shared));
	const user = (kept: readonly number[]) =>
		`${header(kept.length)}\n\n${kept.map((index) => sections[index]).join("\n\n")}\n\n---\n\n${task(notes[kept[0]].link)}`;
	const after = (exampleLink: string): ChatMessage[] =>
		followUp
			? conversationMessages(
					followUp.conversation,
					followUp.question,
					fill(`${QUESTION_FORMAT}\n\n${REMINDER}`, exampleLink),
				)
			: [];
	const afterLength = (exampleLink: string) =>
		after(exampleLink).reduce((sum, message) => sum + message.content.length, 0);

	// Measured without building every candidate prompt: a long range can hold
	// hundreds of notes, and the search may try many counts.
	const limit = contextLimit(limits.contextLength, limits.maxContext);
	const fixed =
		system(notes[0].link).length +
		task(notes[0].link).length +
		afterLength(notes[0].link) +
		"\n\n".length +
		"\n\n---\n\n".length;
	const lengthOf = (kept: readonly number[]) =>
		fixed +
		header(kept.length).length +
		kept.reduce((sum, index) => sum + sections[index].length, 0) +
		"\n\n".length * (kept.length - 1);
	const fitsLength = (length: number) => estimateTokens(length) * ESTIMATE_MARGIN + ANSWER_TOKENS <= limit;
	const fits = (count: number) => fitsLength(lengthOf(spreadEvenly(notes.length, count)));
	let count = notes.length;
	if (!fits(count)) {
		// The most notes that could fit, were the shortest ones picked: no
		// larger count can. Spread evenly, a larger count is not always longer,
		// so the counts below it are tried in turn, as many as fit winning.
		const shortest = sections.map((section) => section.length).sort((left, right) => left - right);
		let ceiling = 0;
		let total = 0;
		while (
			ceiling < notes.length - 1 &&
			fitsLength(fixed + header(ceiling + 1).length + total + shortest[ceiling] + "\n\n".length * ceiling)
		) {
			total += shortest[ceiling];
			ceiling++;
		}
		// One note is always sent, even when it alone is too long.
		count = Math.max(1, ceiling);
		while (count > 1 && !fits(count)) count--;
	}

	const kept = spreadEvenly(notes.length, count);
	const exampleLink = notes[kept[0]].link;
	const messages: ChatMessage[] = [
		{ role: "system", content: system(exampleLink) },
		{ role: "user", content: user(kept) },
		...after(exampleLink),
	];
	const estimate = estimateTokens(messages.reduce((sum, message) => sum + message.content.length, 0));
	return {
		messages,
		range,
		sources: kept.map((index) => ({ key: notes[index].key, path: notes[index].path, link: notes[index].link })),
		total: notes.length,
		estimate,
		numCtx: Math.min(
			limit,
			Math.ceil((estimate * ESTIMATE_MARGIN + ANSWER_TOKENS) / CONTEXT_STEP) * CONTEXT_STEP,
		),
	};
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
 * `2026-10-05` that is exactly a note's link text becomes its link. Only
 * notes that were read are linked; anything else, including links to notes
 * that were not read and text in code, is left as written.
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
	return text.replace(pattern, (match: string, inner?: string, before?: string, bare?: string) => {
		if (bare !== undefined) return `${before ?? ""}[[${bare}]]`;
		if (inner === undefined || targets.has(inner)) return match;
		const parts = inner.split(/[,;]/).map((part) => part.trim());
		if (parts.length < 2 || !parts.every((part) => targets.has(part))) return match;
		return parts.map((part) => `[[${part}]]`).join(", ");
	});
}
