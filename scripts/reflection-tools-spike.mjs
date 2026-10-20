#!/usr/bin/env node
//
// Throwaway spike for Reflection's tools (docs/plans/reflection.md, "Context
// and tools"): asks the sample journal questions of the reader's own through
// local Ollama models that read it with tools, and records every call, its
// arguments, what it returned, the answer, timings and whether the citations
// resolve.
//
// The tools, their descriptions, the prompts and the loop mirror
// src/reflection/tools.ts, which cannot run outside Obsidian. Keep the two in
// step while this script lives; drop it once the tools have settled.
//
// Usage:
//   npm run sample-journal
//   node scripts/reflection-tools-spike.mjs [--models a,b] [--questions id,id]
//     [--today YYYY-MM-DD] [--folder path] [--server url] [--max-context tokens]
//     [--exclude-tag tag] [--runs n] [--label name]
//
// Results land in test-vault/.reflection-spike/tools-<run>/, which Obsidian hides.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { formatDate, JOURNAL_FOLDER } from "./sample-journal.mjs";

const DEFAULT_MODELS = ["gemma4:e4b", "gemma4:26b"];
/** The sample journal's own today, so its planted dates line up. */
const SAMPLE_TODAY = "2026-10-19";

// --- Mirrors src/reflection/context.ts and presets.ts --------------------------

const CHARS_PER_TOKEN = 4;
const ESTIMATE_MARGIN = 1.1;
const ANSWER_TOKENS = 1024;
const DEFAULT_CONTEXT = 8192;

const QUESTION_FORMAT =
	"Answer in a few short paragraphs or bullets. Give each point the link of the note it comes from. If the notes do not answer the question, say so.";
const REMINDER =
	'Write to me as "you". Cite only with the links exactly as written in the headings above, such as {exampleLink}, one note per link. Use only what the notes say. No praise, no advice, no closing summary.';

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
];
const SHORT_MONTHS = MONTHS.map((month) => month.slice(0, 3));

const dateOf = (key) => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));

function longDate(key, withYear) {
	const date = dateOf(key);
	const text = `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]}`;
	return withYear ? `${text} ${date.getFullYear()}` : text;
}

const isLeapYear = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

function onThisDay(key, today) {
	const monthDay = today.slice(5);
	if (key.slice(5) === monthDay) return true;
	return monthDay === "02-29" && key.slice(5) === "02-28" && !isLeapYear(Number(key.slice(0, 4)));
}

const demoteHeadings = (body) => body.replace(/^(#{1,3})(?=[ \t])/gm, (hashes) => "#".repeat(hashes.length + 3));

function restatesDate(value, note) {
	if (value === note.key || value === note.name) return true;
	if (value.startsWith(`${note.key}T`) || value.startsWith(`${note.key} `)) return true;
	return value.toLowerCase() === WEEKDAYS[dateOf(note.key).getDay()].toLowerCase();
}

function propertyLine(note, shared) {
	const parts = [];
	for (const [key, values] of note.properties) {
		const kept = values.filter((value) => !restatesDate(value, note) && !shared.get(key)?.has(value));
		if (kept.length) parts.push(`${key}: ${kept.join(", ")}`);
	}
	return parts.join(" · ");
}

function formatNote(note, withYear, shared) {
	const properties = propertyLine(note, shared);
	const heading = `### ${note.link} · ${longDate(note.key, withYear)}`;
	return `${heading}\n${properties ? `${properties}\n` : ""}\n${note.body}`.trimEnd();
}

function spreadEvenly(length, count) {
	if (count >= length) return Array.from({ length }, (_, index) => index);
	if (count <= 1) return length ? [length - 1] : [];
	const picked = [];
	for (let index = 0; index < count; index++) picked.push(Math.round((index * (length - 1)) / (count - 1)));
	return picked;
}

const estimateTokens = (characters) => Math.ceil(characters / CHARS_PER_TOKEN);

function contextLimit(contextLength, maxContext) {
	const model = contextLength !== null && contextLength > 0 ? contextLength : DEFAULT_CONTEXT;
	return Number.isFinite(maxContext) && maxContext > 0 ? Math.min(model, maxContext) : model;
}

// --- Mirrors src/reflection/tools.ts ------------------------------------------

/** Rounds that may call tools, before the model is asked for its answer. */
const MAX_ROUNDS = 6;
/** Calls answered in one round; the rest are told to wait. */
const MAX_CALLS_PER_ROUND = 8;
/** Kept free after a tool result, for the next call and its arguments. */
const ROUND_RESERVE = 512;
/** Below this, a tool result is not worth sending: the model is told to answer. */
const MIN_RESULT_TOKENS = 256;
/** Added per message for the chat template's own markup. */
const MESSAGE_OVERHEAD = 16;
/** A list longer than this many days is given by month instead. */
const MAX_LISTED_NOTES = 120;
/** Characters of a note's opening, in a list. */
const PREVIEW_LENGTH = 90;
/** Notes a search shows, and the characters around each match. */
const MAX_SEARCH_NOTES = 30;
const EXCERPTS_PER_NOTE = 2;
const EXCERPT_BEFORE = 90;
const EXCERPT_AFTER = 150;

const DATE_ARGUMENT = "written YYYY-MM-DD";

const TOOLS = [
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
				date: { type: "string", description: `The date, ${DATE_ARGUMENT}; only its month and day count. Leave it out for today.` },
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

const SYSTEM_PROMPT = `You answer questions about someone's private journal, which you can only see by reading it with the tools.

- Before you answer, look: search or list the journal to find the notes the question needs, then read them in full. Excerpts and lists alone are too thin to answer from. Write dates as YYYY-MM-DD.
- Ground every point in specific notes, and cite each one with the exact link shown in its heading or line in the tool results, such as {exampleLink}.
- When the notes do not answer the question, say so instead of filling the gap.
- No praise, no generic advice, no therapy-speak.
- Write to the reader in the second person, in the language their notes are written in.
- Keep it to about 150–300 words unless the question asks otherwise.
- Never mention the tools, or suggest reading more: answer from what you have read.`;

/** After the question, in place of the preset reminder, since the notes come later. */
const TOOL_REMINDER =
	'Write to me as "you". Cite only with the links exactly as the tool results show them, such as {exampleLink}, one note per link. Use only what the notes say. No praise, no advice, no closing summary.';

/** Asked once the model has answered without reading anything. */
const LOOK_FIRST = "You have not read any of my notes yet. Look in my journal with the tools first, then answer from what they show.";

/** Asked once the model has answered from excerpts or a list alone. */
const READ_FIRST =
	"Excerpts and lists are too thin to answer from. Read the notes that matter in full with read_journal first, then answer.";

/** Asked once the tools are taken away. */
const ANSWER_NOW = "Answer my question now, from the notes above.";

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function shortDate(key, withYear) {
	const date = dateOf(key);
	return `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]}${withYear ? ` ${date.getFullYear()}` : ""}`;
}

/** "5 Oct – 19 Oct", with years when the range leaves this year. */
function spanLabel(from, to, today) {
	const withYear = from.slice(0, 4) !== today.slice(0, 4) || to.slice(0, 4) !== today.slice(0, 4);
	return from === to ? shortDate(from, withYear) : `${shortDate(from, withYear)} – ${shortDate(to, withYear)}`;
}

/**
 * Reads a date argument: `YYYY-MM-DD`, or a datetime starting with one. A
 * month and day alone, `MM-DD`, falls in `year` when one is given.
 */
function parseDateArgument(value, name, tool, year = null) {
	const text = typeof value === "string" ? value.trim() : "";
	const example = `such as "${name}": "2026-10-05"`;
	if (!text) return { error: `"${name}" is missing. Call ${tool} again with a date ${DATE_ARGUMENT}, ${example}.` };
	const full = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
	const short = year === null ? null : /^-{0,2}(\d{1,2})-(\d{1,2})$/.exec(text);
	const parts = full ? full.slice(1).map(Number) : short ? [year, ...short.slice(1).map(Number)] : null;
	if (parts) {
		const date = new Date(parts[0], parts[1] - 1, parts[2]);
		if (date.getFullYear() === parts[0] && date.getMonth() === parts[1] - 1 && date.getDate() === parts[2]) {
			return { key: formatDate(date) };
		}
	}
	return { error: `"${name}" must be a date ${DATE_ARGUMENT}, not "${text}". Call ${tool} again with one, ${example}.` };
}

function stringArgument(value) {
	return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/**
 * The journal a run reads: every note the filters let through up to today,
 * the values most notes share, and what has been shown to the model.
 */
class Journal {
	constructor(notes, today) {
		this.today = today;
		this.notes = notes.filter((note) => note.key <= today);
		this.shared = sharedAcross(this.notes);
		/** Paths whose whole body was passed, and paths seen only in lists or excerpts. */
		this.read = new Map();
		this.glimpsed = new Map();
		/** Paths a search found, which a read keeps first when not all fit. */
		this.hits = new Set();
		this.searches = 0;
	}

	get first() {
		return this.notes[0]?.key ?? this.today;
	}

	/** Checks a range's arguments, clamped to the journal; an optional range defaults to all of it. */
	range(args, tool, { optional = false } = {}) {
		const hasFrom = stringArgument(args.from) !== "";
		const hasTo = stringArgument(args.to) !== "";
		if (optional && !hasFrom && !hasTo) return { from: this.first, to: this.today, notes: [] };
		const from = hasFrom || !optional ? parseDateArgument(args.from, "from", tool) : { key: this.first };
		if (from.error) return { error: from.error };
		const to = hasTo || !optional ? parseDateArgument(args.to, "to", tool) : { key: this.today };
		if (to.error) return { error: to.error };
		const notes = [];
		let start = from.key;
		let end = to.key;
		if (start > end) {
			[start, end] = [end, start];
			notes.push(`"from" was after "to", so they were swapped.`);
		}
		if (start > this.today) {
			return { error: `${start} is after today, ${this.today}, so there are no notes yet. Call ${tool} again with an earlier range.` };
		}
		if (end > this.today) end = this.today;
		if (start < this.first) start = this.first;
		return { from: start, to: end, notes };
	}

	notesIn(from, to) {
		return this.notes.filter((note) => note.key >= from && note.key <= to);
	}
}

/** Per property, the values held by nearly every note in the journal, such as `type: daily`. */
function sharedAcross(notes) {
	const shared = new Map();
	if (notes.length < 2) return shared;
	const counts = new Map();
	for (const note of notes) {
		for (const [key, values] of note.properties) {
			const byValue = counts.get(key) ?? new Map();
			counts.set(key, byValue);
			for (const value of new Set(values)) byValue.set(value, (byValue.get(value) ?? 0) + 1);
		}
	}
	for (const [key, byValue] of counts) {
		const common = [...byValue].filter(([, count]) => count >= notes.length * 0.9).map(([value]) => value);
		if (common.length) shared.set(key, new Set(common));
	}
	return shared;
}

const withYearFor = (journal, from, to) => from.slice(0, 4) !== to.slice(0, 4) || to.slice(0, 4) !== journal.today.slice(0, 4);

function preview(body) {
	const text = body
		.replace(/^#+\s+.*$/gm, " ")
		.replace(/^\s*[-*+]\s+(\[.\]\s+)?/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH).replace(/\s+\S*$/, "")}…` : text;
}

const words = (text) => text.split(/\s+/).filter(Boolean).length;

function listJournal(journal, args, room) {
	const range = journal.range(args, "list_journal", { optional: true });
	if (range.error) return { content: range.error };
	const { from, to } = range;
	const notes = journal.notesIn(from, to);
	const withYear = withYearFor(journal, from, to);
	const span = `${longDate(from, withYear)} to ${longDate(to, withYear)}`;
	const status = `Listing ${spanLabel(from, to, journal.today)}`;
	if (!notes.length) return { status, content: [...range.notes, `There are no notes from ${span}.`].join("\n") };
	const lines = notes.map((note) => {
		const properties = propertyLine(note, journal.shared);
		const parts = [note.link, longDate(note.key, withYear), plural(words(note.body), "word")];
		if (properties) parts.push(properties);
		const opening = preview(note.body);
		return `- ${parts.join(" · ")}${opening ? `: ${opening}` : ""}`;
	});
	let content = [
		...range.notes,
		`${plural(notes.length, "note")} from ${span}, oldest first. Read them with read_journal, or find words in them with search_journal.`,
		"",
		...lines,
	].join("\n");
	if (notes.length > MAX_LISTED_NOTES || content.length > room) {
		content = [
			...range.notes,
			`${plural(notes.length, "note")} from ${span}: too many to list one by one, so here they are by month. List a shorter range to see each note.`,
			"",
			...byMonth(notes, journal),
		].join("\n");
	}
	for (const note of notes) if (!journal.read.has(note.path)) journal.glimpsed.set(note.path, note);
	return { status, content };
}

/** The tags notes hold, most used first, such as `work (8), family (5)`, leaving out those nearly every note holds. */
function tagCounts(notes, journal, max = 8) {
	const counts = new Map();
	for (const note of notes) {
		for (const tag of new Set(note.tags.map(normalizeTag))) {
			if (journal.shared.get("tags")?.has(tag)) continue;
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
	}
	return [...counts]
		.sort((left, right) => right[1] - left[1])
		.slice(0, max)
		.map(([tag, count]) => `${tag} (${count})`)
		.join(", ");
}

function byMonth(notes, journal) {
	const months = new Map();
	for (const note of notes) {
		const month = note.key.slice(0, 7);
		months.set(month, [...(months.get(month) ?? []), note]);
	}
	return [...months].map(([month, inMonth]) => {
		const name = `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
		const tags = tagCounts(inMonth, journal, 6);
		return `- ${name}: ${plural(inMonth.length, "note")}${tags ? ` · tags: ${tags}` : ""}`;
	});
}

/**
 * Formats `notes` within `room` characters: notes already shown are named
 * rather than repeated, and when the rest do not fit, whole notes are dropped
 * evenly across them and named as plain dates, so the model can read them by
 * a narrower range.
 */
function passNotes(journal, notes, withYear, header, room) {
	const fresh = notes.filter((note) => !journal.read.has(note.path));
	const repeated = notes.filter((note) => journal.read.has(note.path));
	const sections = fresh.map((note) => formatNote(note, withYear, journal.shared));
	const already = repeated.length
		? `Already shown above, so not repeated: ${listOf(repeated.map((note) => note.link))}.`
		: "";
	if (!fresh.length) return { content: `${already} Answer from them, or read another range.`, passed: 0, total: 0 };
	// When not all fit, the notes a search found go first.
	const found = [];
	const others = [];
	for (const [index, note] of fresh.entries()) (journal.hits.has(note.path) ? found : others).push(index);
	const pick = (count) => {
		if (count >= fresh.length) return fresh.map((_, index) => index);
		if (count <= found.length) return spreadEvenly(found.length, count).map((index) => found[index]);
		const rest = spreadEvenly(others.length, count - found.length).map((index) => others[index]);
		return [...found, ...rest].sort((left, right) => left - right);
	};
	const compose = (kept) => {
		const left = fresh.filter((_, index) => !kept.includes(index));
		const parts = [header(kept.length, fresh.length)];
		if (already) parts.push(already);
		if (kept.length) parts.push(kept.map((index) => sections[index]).join("\n\n"));
		if (left.length) {
			parts.push(
				`Not shown, for want of room: ${listOf(left.map((note) => note.key))}. Read a shorter range, or search for what you need, to see them.`,
			);
		}
		return parts.join("\n\n");
	};
	let count = fresh.length;
	let content = compose(pick(count));
	while (count > 0 && content.length > room) {
		count--;
		content = compose(pick(count));
	}
	const kept = pick(count);
	for (const index of kept) {
		journal.read.set(fresh[index].path, fresh[index]);
		journal.glimpsed.delete(fresh[index].path);
	}
	return { content, passed: kept.length, total: fresh.length };
}

/** Items joined with commas, the long tail counted rather than written out. */
function listOf(items, max = 20) {
	if (items.length <= max) return items.join(", ");
	return `${items.slice(0, max).join(", ")} and ${items.length - max} more, up to ${items[items.length - 1]}`;
}

function readJournal(journal, args, room) {
	const range = journal.range(args, "read_journal");
	if (range.error) return { content: range.error };
	const { from, to } = range;
	const tag = normalizeTag(stringArgument(args.tag));
	const withYear = withYearFor(journal, from, to);
	const span = `${longDate(from, withYear)} to ${longDate(to, withYear)}`;
	const status = `Reading ${spanLabel(from, to, journal.today)}${tag ? ` · #${tag}` : ""}`;
	const inRange = journal.notesIn(from, to);
	if (!inRange.length) return { status, content: [...range.notes, `There are no notes from ${span}.`].join("\n") };
	let notes = tag ? inRange.filter((note) => note.tags.some((candidate) => tagMatches(candidate, tag))) : inRange;
	if (!notes.length) {
		// Models take a topic for a tag, and rarely call again without it.
		const tags = tagCounts(inRange, journal);
		range.notes.push(`None of these notes has the tag ${tag}${tags ? `; their tags are ${tags}` : ""}. Here they all are.`);
		notes = inRange;
	}
	const tagged = notes !== inRange;
	const header = (passed, total) =>
		[
			...range.notes,
			`My notes from ${span}${tagged ? ` tagged ${tag}` : ""}, oldest first (${passed === total ? plural(total, "note") : `${passed} of ${plural(total, "note")}`}):`,
		].join("\n");
	const result = passNotes(journal, notes, withYear, header, room);
	return { status, content: result.content };
}

function onThisDayTool(journal, args, room) {
	const asked = stringArgument(args.date);
	const year = Number(journal.today.slice(0, 4));
	const parsed = asked ? parseDateArgument(asked, "date", "on_this_day", year) : { key: journal.today };
	// The date is often given as "19 October": read it, or fall back to today.
	const key = parsed.key ?? monthDayOf(asked, year);
	const notes = [];
	if (!key) notes.push(`"${asked}" is not a date written YYYY-MM-DD, so today's date was used.`);
	// Only the month and day count: models pass the first year as often as today.
	const date = key ?? journal.today;
	const day = `${dateOf(date).getDate()} ${MONTHS[dateOf(date).getMonth()]}`;
	const status = date.slice(5) === journal.today.slice(5) ? "Looking at this date in earlier years" : `Looking at ${shortDate(date, false)} in earlier years`;
	const found = journal.notes.filter((note) => onThisDay(note.key, date));
	if (!found.length) {
		return { status, content: [...notes, `No note falls on ${day} in any year. Try list_journal for the days around it.`].join("\n") };
	}
	if (new Set(found.map((note) => note.key.slice(0, 4))).size === 1) notes.push(`Only ${found[0].key.slice(0, 4)} has a note on ${day}.`);
	const header = (passed, total) =>
		[...notes, `My notes from ${day} in every year, oldest first (${passed === total ? plural(total, "note") : `${passed} of ${plural(total, "note")}`}):`].join("\n");
	const result = passNotes(journal, found, true, header, room);
	return { status, content: result.content };
}

/** "19 October", "Oct 19" or "October 19, 2024" as a date, in `year` unless it names one. */
function monthDayOf(text, year) {
	const match = /^(?:(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)|([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?)\.?,?(?:\s+(\d{4}))?$/i.exec(text.trim());
	if (!match) return null;
	const name = (match[2] ?? match[3]).toLowerCase();
	const month = MONTHS.findIndex((candidate) => name.length >= 3 && candidate.toLowerCase().startsWith(name));
	if (month === -1) return null;
	const day = Number(match[1] ?? match[4]);
	const date = new Date(match[5] ? Number(match[5]) : year, month, day);
	return date.getMonth() === month && date.getDate() === day ? formatDate(date) : null;
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A word cut back to what its forms share, so running finds run and runs. */
function stemOf(word) {
	const lower = word.toLocaleLowerCase().replace(/['’]s$/, "");
	let stem = lower;
	if (lower.length > 5 && lower.endsWith("ing")) stem = lower.slice(0, -3);
	else if (lower.length > 4 && /ie[sd]$/.test(lower)) return lower.slice(0, -3);
	else if (lower.length > 4 && lower.endsWith("ed")) stem = lower.slice(0, -2);
	else if (lower.length > 4 && /(s|x|z|ch|sh)es$/.test(lower)) return lower.slice(0, -2);
	else if (lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1);
	// The consonant -ing and -ed doubled: runn, stopp.
	return stem !== lower && /([b-df-hj-km-np-rtv-z])\1$/.test(stem) ? stem.slice(0, -1) : stem;
}

const wordsOfQuery = (phrase) => phrase.match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * A phrase at the start of a word, ignoring case, each word in any of its
 * forms. The character before it is matched rather than looked behind at,
 * since lookbehind is missing on iOS before 16.4.
 */
function phrasePattern(phrase) {
	const body = wordsOfQuery(phrase)
		.map((word) => `${escapeRegExp(stemOf(word))}[\\p{L}\\p{N}'’]*`)
		.join("[^\\p{L}\\p{N}]+");
	return new RegExp(`(^|[^\\p{L}\\p{N}_])(${body})`, "giu");
}

/** What a query asks for: alternatives split by OR, `|` or commas, each a phrase. */
function alternativesOf(query) {
	return query
		.split(/\s+OR\s+|\||,/)
		.map((part) => part.trim())
		.filter((part) => wordsOfQuery(part).length > 0);
}

function excerptsOf(body, patterns, limit) {
	const text = body.replace(/\s+/g, " ");
	const found = [];
	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		let match;
		while ((match = pattern.exec(text)) && found.length < 20) found.push(match.index + match[1].length);
	}
	found.sort((a, b) => a - b);
	const excerpts = [];
	let end = -1;
	for (const index of found) {
		if (index < end || excerpts.length >= limit) continue;
		let start = Math.max(0, index - EXCERPT_BEFORE);
		let stop = Math.min(text.length, index + EXCERPT_AFTER);
		if (start > 0) start = text.indexOf(" ", start) + 1 || start;
		if (stop < text.length) stop = text.lastIndexOf(" ", stop) > index ? text.lastIndexOf(" ", stop) : stop;
		excerpts.push(`${start > 0 ? "…" : ""}${text.slice(start, stop).trim()}${stop < text.length ? "…" : ""}`);
		end = stop;
	}
	return excerpts;
}

function searchJournal(journal, args, room) {
	journal.searches++;
	const query = stringArgument(args.query);
	const alternatives = alternativesOf(query);
	if (!alternatives.length) {
		return { content: `"query" is empty. Call search_journal again with a word or short phrase to find, such as a name.` };
	}
	const range = journal.range(args, "search_journal", { optional: true });
	if (range.error) return { content: range.error };
	const { from, to } = range;
	const withYear = withYearFor(journal, from, to);
	const span = `${longDate(from, withYear)} to ${longDate(to, withYear)}`;
	const quoted = `"${alternatives.join('" or "')}"`;
	const status = `Searching for ${quoted}`;
	const notes = journal.notesIn(from, to);
	const patterns = alternatives.map(phrasePattern);
	const tagStems = alternatives
		.filter((part) => wordsOfQuery(part).length === 1)
		.map((part) => stemOf(wordsOfQuery(part)[0]))
		.filter((stem) => stem.length >= 3);
	const inBody = (note) => patterns.some((pattern) => ((pattern.lastIndex = 0), pattern.test(note.body)));
	const inTags = (note) => note.tags.some((tag) => tagStems.some((stem) => normalizeTag(tag).startsWith(stem)));
	const hits = notes.filter((note) => inBody(note) || inTags(note));
	if (!hits.length) {
		return {
			status,
			content: [...range.notes, `No note from ${span} mentions ${quoted}. Try another word for it, or list_journal to see what the notes cover.`].join("\n"),
		};
	}
	const lineFor = (note, limit) => {
		const excerpts = excerptsOf(note.body, patterns, limit);
		const text = excerpts.length ? excerpts.join(" ") : `(tagged) ${preview(note.body)}`;
		return `- ${note.link} · ${longDate(note.key, withYear)}: ${text}`;
	};
	const first = hits[0].key;
	const last = hits[hits.length - 1].key;
	const next =
		first === last
			? `To read it in full: read_journal with {"from": "${first}", "to": "${last}"}.`
			: `To follow it from first mention to last, read that range in full: read_journal with {"from": "${first}", "to": "${last}"}.`;
	const compose = (shown, limit) => {
		const left = hits.filter((note) => !shown.includes(note));
		return [
			...range.notes,
			`${plural(hits.length, "note")} from ${span} ${hits.length === 1 ? "mentions" : "mention"} ${quoted}, oldest first${shown.length < hits.length ? `; ${shown.length} shown` : ""}. These are only excerpts: read the notes that matter in full with read_journal before you answer.`,
			"",
			...shown.map((note) => lineFor(note, limit)),
			...(left.length ? ["", `Also mentioned, not shown for want of room: ${listOf(left.map((note) => note.key))}. Search a shorter range to see them.`] : []),
			"",
			next,
		].join("\n");
	};
	let limit = EXCERPTS_PER_NOTE;
	let count = Math.min(hits.length, MAX_SEARCH_NOTES);
	let shown = spreadEvenly(hits.length, count).map((index) => hits[index]);
	let content = compose(shown, limit);
	if (content.length > room) {
		limit = 1;
		content = compose(shown, limit);
	}
	while (count > 1 && content.length > room) {
		count--;
		shown = spreadEvenly(hits.length, count).map((index) => hits[index]);
		content = compose(shown, limit);
	}
	for (const note of hits) journal.hits.add(note.path);
	for (const note of shown) if (!journal.read.has(note.path)) journal.glimpsed.set(note.path, note);
	return { status, content };
}

const normalizeTag = (value) => value.trim().replace(/^#+/, "").replace(/\/+$/g, "").toLocaleLowerCase();
function tagMatches(candidate, filter) {
	const tag = normalizeTag(candidate);
	return tag === filter || tag.startsWith(`${filter}/`);
}

function runTool(journal, call, room) {
	const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
	switch (call.name) {
		case "list_journal":
			return listJournal(journal, args, room);
		case "read_journal":
			return readJournal(journal, args, room);
		case "on_this_day":
			return onThisDayTool(journal, args, room);
		case "search_journal":
			return searchJournal(journal, args, room);
		default:
			return {
				content: `There is no tool named "${call.name}". The tools are list_journal, read_journal, on_this_day and search_journal.`,
			};
	}
}

// --- Ollama -------------------------------------------------------------------

async function showModel(server, model) {
	const response = await fetch(`${server}/api/show`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model }),
	});
	if (!response.ok) throw new Error(`${model}: /api/show answered ${response.status}`);
	const info = await response.json();
	const lengthKey = Object.keys(info.model_info ?? {}).find((key) => key.endsWith(".context_length"));
	return { capabilities: info.capabilities ?? [], contextLength: lengthKey ? info.model_info[lengthKey] : null };
}

/** The conversation in Ollama's format, as ollama.ts writes it. */
function ollamaMessages(messages) {
	return messages.map((message) => {
		if (message.role === "tool") return { role: "tool", content: message.content, tool_name: message.toolName };
		if (message.role === "assistant" && message.toolCalls?.length) {
			return {
				role: "assistant",
				content: message.content,
				tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })),
			};
		}
		return { role: message.role, content: message.content };
	});
}

function argumentsOf(value) {
	if (value && typeof value === "object" && !Array.isArray(value)) return value;
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		} catch {
			// Not JSON: no arguments.
		}
	}
	return {};
}

async function chat(server, { model, messages, numCtx, tools, numPredict, timeout }) {
	const started = performance.now();
	const response = await fetch(`${server}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: ollamaMessages(messages),
			options: { num_ctx: numCtx, ...(numPredict ? { num_predict: numPredict } : {}) },
			think: false,
			stream: true,
			...(tools ? { tools: tools.map((tool) => ({ type: "function", function: tool })) } : {}),
		}),
		signal: AbortSignal.timeout(timeout),
	}).catch((error) => {
		throw new Error(`no answer after ${seconds(performance.now() - started)}: ${error.message}`);
	});
	if (!response.ok || !response.body) {
		const text = await response.text();
		const error = new Error(`/api/chat answered ${response.status}: ${text}`);
		if (/does not support tools/i.test(text)) error.kind = "no-tools";
		throw error;
	}
	let text = "";
	let firstToken = null;
	let final = {};
	let buffer = "";
	const toolCalls = [];
	const decoder = new TextDecoder();
	const take = (line) => {
		if (!line.trim()) return;
		const part = JSON.parse(line);
		if (part.error) throw new Error(part.error);
		if (part.message?.content) {
			firstToken ??= performance.now() - started;
			text += part.message.content;
		}
		for (const call of part.message?.tool_calls ?? []) {
			if (typeof call?.function?.name === "string") {
				toolCalls.push({ name: call.function.name, arguments: argumentsOf(call.function.arguments) });
			}
		}
		if (part.done) final = part;
	};
	try {
		for await (const chunk of response.body) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				take(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
			}
		}
	} catch (error) {
		throw new Error(`stream broke after ${seconds(performance.now() - started)} with ${text.length} characters: ${error.message}`);
	}
	take(buffer);
	return {
		text,
		toolCalls,
		firstToken,
		total: performance.now() - started,
		promptTokens: final.prompt_eval_count ?? null,
		cachedTokens: final.prompt_eval_cached_count ?? null,
		answerTokens: final.eval_count ?? null,
		doneReason: final.done_reason ?? null,
		loadMs: final.load_duration ? final.load_duration / 1e6 : 0,
	};
}

// --- The loop, as tools.ts runs it --------------------------------------------

function conversationLength(messages, tools) {
	let length = tools ? JSON.stringify(tools.map((tool) => ({ type: "function", function: tool }))).length : 0;
	for (const message of messages) {
		length += message.content.length + MESSAGE_OVERHEAD;
		if (message.toolCalls?.length) length += JSON.stringify(message.toolCalls).length;
	}
	return length;
}

async function reflectWithTools(options, model, info, question, journal, log) {
	const limit = contextLimit(info.contextLength, options.maxContext);
	const numCtx = limit;
	const exampleLink = journal.notes[journal.notes.length - 1]?.link ?? `[[${journal.today}]]`;
	const fill = (text) => text.replaceAll("{exampleLink}", exampleLink);
	const span = journal.notes.length
		? ` The journal holds ${plural(journal.notes.length, "note")}, from ${longDate(journal.first, true)} to ${longDate(journal.notes[journal.notes.length - 1].key, true)}.`
		: "";
	const messages = [
		{ role: "system", content: `${fill(SYSTEM_PROMPT)}\n\nToday is ${longDate(journal.today, true)} (${journal.today}).${span}` },
		{ role: "user", content: `${question}\n\n${QUESTION_FORMAT}\n\n${fill(TOOL_REMINDER)}` },
	];
	/** Tokens per estimated token, raised when the server counts more than estimated. */
	let ratio = ESTIMATE_MARGIN;
	const seen = new Set();
	let looked = false;
	const nudged = new Set();
	let full = false;
	const send = async (tools) => {
		const length = conversationLength(messages, tools);
		const result = await chat(options.server, { model, messages, numCtx, tools, numPredict: options.numPredict, timeout: options.timeout });
		if (result.promptTokens) ratio = Math.max(ratio, result.promptTokens / estimateTokens(length));
		log.rounds.push({ tools: Boolean(tools), estimate: estimateTokens(length), ...result, calls: [] });
		return result;
	};
	const roomFor = () => {
		const used = estimateTokens(conversationLength(messages, TOOLS) + MESSAGE_OVERHEAD) * ratio;
		const tokens = limit - used - ANSWER_TOKENS - ROUND_RESERVE;
		return Math.floor((tokens / ratio) * CHARS_PER_TOKEN);
	};

	for (let round = 0; round < MAX_ROUNDS && !full; round++) {
		const result = await send(TOOLS);
		const entry = log.rounds[log.rounds.length - 1];
		// Some models write their calls out as JSON instead of making them.
		if (!result.toolCalls.length) {
			const written = callsInText(result.text);
			if (written.length) {
				entry.writtenCalls = true;
				result.toolCalls = written;
				result.text = "";
			}
		}
		if (result.toolCalls.length) {
			messages.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });
			for (const [index, call] of result.toolCalls.entries()) {
				const signature = `${call.name}:${JSON.stringify(call.arguments)}`;
				let outcome;
				const room = roomFor();
				if (index >= MAX_CALLS_PER_ROUND) {
					outcome = { content: `Too many calls at once; this one was not run. Ask again if you still need it.` };
				} else if (seen.has(signature)) {
					outcome = { content: "This call was already answered above. Use that result, or try something else." };
				} else if (room < MIN_RESULT_TOKENS * CHARS_PER_TOKEN) {
					outcome = { content: "There is no room left to read more. Answer from the notes above." };
					full = true;
				} else {
					outcome = runTool(journal, call, room);
					seen.add(signature);
					looked = true;
				}
				entry.calls.push({ call, status: outcome.status ?? null, content: outcome.content, room });
				messages.push({ role: "tool", content: outcome.content, toolName: call.name });
			}
			continue;
		}
		if (written(result.text)) {
			// An answer given before looking is made up, and one from excerpts is
			// thin: each is dropped once, unseen, so it cannot anchor the next.
			// Not sent back after a search that found nothing, when the answer
			// cites nothing: sent back after "no note mentions Lisbon", qwen3:8b
			// read the whole journal and found a dream about it.
			const leans = journal.hits.size > 0 || journal.searches === 0 || result.text.includes("[[") || [...journal.glimpsed.values()].some((note) => result.text.includes(note.link.slice(2, -2)));
			const nudge = !looked ? LOOK_FIRST : !journal.read.size && journal.glimpsed.size && leans ? READ_FIRST : null;
			if (nudge && !nudged.has(nudge) && options.nudge !== "off") {
				nudged.add(nudge);
				entry.discarded = !looked ? "answered without looking" : "answered from excerpts";
				messages.push({ role: "user", content: nudge });
				continue;
			}
			return { text: result.text, messages, numCtx, limit, ratio };
		}
		entry.discarded = "empty answer";
		break;
	}
	messages.push({ role: "user", content: `${ANSWER_NOW} ${question}\n\n${QUESTION_FORMAT}\n\n${fill(REMINDER)}` });
	const result = await send(undefined);
	if (!written(result.text)) throw new Error("The model finished without writing an answer");
	return { text: result.text, messages, numCtx, limit, ratio, forced: true };
}

/**
 * True when a round wrote something to read. Gemma 4 sometimes loops on its
 * own markup without writing, until the cap on its answer stops it, leaving
 * a stray token such as `<channel|>`.
 */
const written = (text) => text.replace(/<\|?[a-z_]+\|?>/g, "").trim() !== "";

/** Tool calls a model wrote into its answer as JSON, such as `{"name": "read_journal", "parameters": {…}}`. */
function callsInText(text) {
	const names = new Set(TOOLS.map((tool) => tool.name));
	const calls = [];
	for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
		const end = closingBrace(text, start);
		if (end === -1) break;
		let parsed = null;
		try {
			parsed = JSON.parse(text.slice(start, end + 1));
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object" || !names.has(parsed.name)) continue;
		calls.push({ name: parsed.name, arguments: argumentsOf(parsed.parameters ?? parsed.arguments) });
		start = end;
	}
	return calls;
}

/** Where the JSON object opening at `start` closes, or -1. */
function closingBrace(text, start) {
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

// --- Checking -----------------------------------------------------------------

function checkCitations(text, journal) {
	const read = new Set([...journal.read.values()].map((note) => note.link.slice(2, -2)));
	const glimpsed = new Set([...journal.glimpsed.values()].map((note) => note.link.slice(2, -2)));
	const cited = [...new Set([...text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1].trim()))];
	return {
		cited,
		read: cited.filter((link) => read.has(link)),
		glimpsed: cited.filter((link) => glimpsed.has(link)),
		unknown: cited.filter((link) => !read.has(link) && !glimpsed.has(link)),
		bareDates: [...text.matchAll(/(^|[^[\d-])(\d{4}-\d{2}-\d{2})(?![\d\]-])/g)].length,
	};
}

const seconds = (ms) => (ms == null ? "-" : `${(ms / 1000).toFixed(1)} s`);

// --- Main ---------------------------------------------------------------------

export const QUESTIONS = [
	{ id: "running", text: "When did I stop running, and why?" },
	{ id: "mina", text: "What did I write about Mina?" },
	{ id: "reorg", text: "What happened with the reorg at work?" },
	{ id: "this-date", text: "What was I doing on this date in past years?" },
	{ id: "farahani", text: "Did I ever write to Mr. Farahani?" },
	{ id: "lisbon", text: "How did my trip to Lisbon go?" },
	{ id: "learned", text: "What did I learn in the last two weeks?" },
	{ id: "headaches", text: "What did the doctor say about my headaches, and did it help?" },
];

function parseArgs(argv) {
	const value = (flag, fallback) => {
		const index = argv.indexOf(flag);
		return index === -1 ? fallback : argv[index + 1];
	};
	return {
		models: value("--models", DEFAULT_MODELS.join(",")).split(","),
		questions: value("--questions", QUESTIONS.filter((q) => q.id !== "headaches").map((q) => q.id).join(",")).split(","),
		today: value("--today", SAMPLE_TODAY),
		folder: value("--folder", JOURNAL_FOLDER),
		server: value("--server", "http://127.0.0.1:11434").replace(/\/$/, ""),
		maxContext: Number(value("--max-context", "32768")),
		excludeTag: value("--exclude-tag", ""),
		runs: Number(value("--runs", "1")),
		label: value("--label", ""),
		nudge: value("--nudge", "on"),
		numPredict: Number(value("--num-predict", "2048")),
		timeout: Number(value("--timeout", "180")) * 1000,
	};
}

function readNotes(folder, excludeTag) {
	return readdirSync(folder)
		.filter((name) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(name))
		.sort()
		.map((name) => {
			const base = basename(name, ".md");
			const text = readFileSync(join(folder, name), "utf8");
			const properties = propertiesOf(text);
			const tags = [...(properties.get("tags") ?? []), ...[...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((m) => m[1])];
			return {
				key: base.slice(0, 10),
				path: `Journal/${name}`,
				link: `[[${base}]]`,
				name: base,
				body: demoteHeadings(text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim()),
				properties,
				tags,
			};
		})
		.filter((note) => !excludeTag || !note.tags.some((tag) => tagMatches(tag, excludeTag)));
}

/** Simple YAML: `key: value` lines and `key:` followed by `  - item` lines. */
function propertiesOf(text) {
	const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
	const properties = new Map();
	let list = null;
	for (const line of frontmatter.split("\n")) {
		const item = /^\s+- (.+)$/.exec(line);
		if (item && list) {
			list.push(item[1].trim());
			continue;
		}
		const pair = /^([\w-]+):\s*(.*)$/.exec(line);
		if (!pair) continue;
		if (pair[2] === "") {
			list = [];
			properties.set(pair[1], list);
		} else {
			list = null;
			if (pair[2].trim()) properties.set(pair[1], [pair[2].trim()]);
		}
	}
	for (const [key, values] of properties) if (!values.length) properties.delete(key);
	return properties;
}

function transcript(label, question, model, outcome, log, journal, citations, total) {
	const lines = [`# ${label}`, "", `Question: ${question}`, ""];
	lines.push(
		`- Model: ${model}; context ${outcome?.limit ?? "?"} (num_ctx ${outcome?.numCtx ?? "?"}), token ratio ${outcome ? outcome.ratio.toFixed(2) : "?"}`,
		`- Rounds: ${log.rounds.length}${outcome?.forced ? ", answer forced without tools" : ""}; total ${seconds(total)}`,
		`- Read in full: ${[...journal.read.values()].map((note) => note.key).join(", ") || "none"}`,
		`- Cited: ${citations.cited.join(", ") || "none"}; read ${citations.read.length}, seen in lists or excerpts only ${citations.glimpsed.length}, never shown ${citations.unknown.length}${citations.unknown.length ? ` (${citations.unknown.join(", ")})` : ""}; ${citations.bareDates} bare dates`,
		"",
	);
	for (const [index, round] of log.rounds.entries()) {
		lines.push(
			`## Round ${index + 1}${round.tools ? "" : " (no tools)"}`,
			"",
			`${seconds(round.total)} (load ${seconds(round.loadMs)}), prompt ~${round.estimate} est. / ${round.promptTokens ?? "?"} counted (${round.cachedTokens ?? "?"} cached), ${round.answerTokens ?? "?"} generated, ${round.doneReason ?? "?"}${round.discarded ? `; discarded: ${round.discarded}` : ""}${round.writtenCalls ? "; calls written as text" : ""}`,
			"",
		);
		if (round.text.trim()) lines.push("Text:", "", "> " + round.text.trim().split("\n").join("\n> "), "");
		for (const { call, status, content, room } of round.calls) {
			lines.push(`### ${call.name}(${JSON.stringify(call.arguments)})`, "", `Status: ${status ?? "(none)"} · room ${room} chars · result ${content.length} chars`, "", "```text", content, "```", "");
		}
	}
	lines.push("## Answer", "", outcome?.text ?? "(none)", "");
	return lines.join("\n");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const notes = readNotes(options.folder, options.excludeTag);
	if (!notes.length) throw new Error(`No notes in ${options.folder}; run npm run sample-journal`);
	const questions = options.questions.map((id) => {
		const question = QUESTIONS.find((candidate) => candidate.id === id);
		if (!question) throw new Error(`Unknown question ${id}`);
		return question;
	});
	const runId = `tools-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}${options.label ? `-${options.label}` : ""}`;
	const out = join(JOURNAL_FOLDER, "..", ".reflection-spike", runId);
	mkdirSync(out, { recursive: true });
	const rows = [];

	for (const model of options.models) {
		const info = await showModel(options.server, model);
		for (const question of questions) {
			for (let run = 1; run <= options.runs; run++) {
				const label = `${model} · ${question.id}${options.runs > 1 ? ` · run ${run}` : ""}`;
				process.stdout.write(`${label} … `);
				const journal = new Journal(notes, options.today);
				const log = { rounds: [] };
				const started = performance.now();
				let outcome = null;
				let error = null;
				try {
					outcome = await reflectWithTools(options, model, info, question.text, journal, log);
				} catch (caught) {
					error = caught;
				}
				const total = performance.now() - started;
				const citations = checkCitations(outcome?.text ?? "", journal);
				const calls = log.rounds.flatMap((round) => round.calls.map(({ call }) => `${call.name}(${Object.values(call.arguments).join(", ")})`));
				const file = `${model.replace(/[^\w.-]/g, "_")}--${question.id}${options.runs > 1 ? `--${run}` : ""}.md`;
				writeFileSync(
					join(out, file),
					transcript(label, question.text, model, outcome, log, journal, citations, total) + (error ? `\n## Error\n\n${error.message}\n` : ""),
				);
				if (error) {
					console.log(`failed${error.kind ? ` (${error.kind})` : ""}: ${error.message}`);
					rows.push({ model, question: question.id, run, error: `${error.kind ? `${error.kind}: ` : ""}${error.message}` });
					continue;
				}
				console.log(`${log.rounds.length} rounds, ${seconds(total)}, ${calls.join("; ")}; cited ${citations.cited.length} (${citations.unknown.length} never shown)`);
				rows.push({
					model,
					question: question.id,
					run,
					rounds: log.rounds.length,
					forced: Boolean(outcome.forced),
					calls: calls.join("; "),
					read: journal.read.size,
					total: seconds(total),
					words: words(outcome.text),
					cited: citations.cited.length,
					glimpsed: citations.glimpsed.length,
					unknown: citations.unknown.length,
				});
			}
		}
	}

	const header =
		"| Model | Question | Rounds | Calls | Read | Time | Words | Cited | Excerpt only | Never shown |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
	const lines = rows.map((row) =>
		row.error
			? `| ${row.model} | ${row.question} | failed: ${row.error.replace(/\|/g, "/")} | | | | | | | |`
			: `| ${row.model} | ${row.question} | ${row.rounds}${row.forced ? " (forced)" : ""} | ${row.calls.replace(/\|/g, "/")} | ${row.read} | ${row.total} | ${row.words} | ${row.cited} | ${row.glimpsed} | ${row.unknown} |`,
	);
	const settings = `Today ${options.today}, max context ${options.maxContext}${options.excludeTag ? `, excluding #${options.excludeTag}` : ""}.`;
	writeFileSync(join(out, "summary.md"), `${settings}\n\n${header}\n${lines.join("\n")}\n`);
	console.log(`\nResults in ${out}`);
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
