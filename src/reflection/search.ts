import { normalizeWord, stemWord } from "../vocabulary";

/*
 * The search a reflection's model runs over the journal: every note's words
 * indexed once, a query's words matched in any of their forms, and the notes
 * that match ranked so the best ones are shown first. Nothing here touches
 * Obsidian, so the spike (scripts/reflection-spike.mjs) runs it as it is.
 */

/** A word: letters and digits, with the marks, apostrophes and joiners inside it. */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’‌]*/gu;

/** How much a word's length matters, and how soon repeating it stops counting: the usual BM25 values. */
const K1 = 1.2;
const B = 0.75;
/**
 * A query word this long also finds the words that start with it, so
 * `garden` finds `gardener`. English words have a stemmer for their forms,
 * and shorter ones find too much: `plan` would find `plant` and `planet`.
 * Other languages have only this, so their words need less.
 */
const PREFIX_LENGTH = 5;
const PREFIX_LENGTH_UNSTEMMED = 3;
/** What a word found only by its start counts for, against the word itself. */
const PREFIX_WEIGHT = 0.6;
/**
 * Two words that share this many letters at their start, and most of the
 * shorter one, are taken for forms of one word, so `reorganization` finds
 * `reorganising` and `reorg`. They count for less again.
 */
const KIN_LENGTH = 5;
const KIN_SHARE = 0.7;
const KIN_WEIGHT = 0.4;
/** What a word in a note's tags and properties counts for, against one in its text. */
const EXTRA_WEIGHT = 2;
/** A word in more than this share of the notes says nothing beside a rarer one, as `to` beside `Lisbon`. */
const COMMON_SHARE = 0.4;
/** What a note keeps of a several-word query's score when it holds only some of the words, at the least. */
const PARTIAL_FLOOR = 0.5;
/** What the words of a query standing together, in order, multiply a note's score by. */
const ADJACENT_BONUS = 1.5;
/**
 * English words that carry no subject. A query written as a phrase, "the
 * teacher who inspired me", is searched for its other words; one made of
 * nothing else is searched as it stands. Other languages are left to
 * `COMMON_SHARE`, which drops whatever most of the notes hold.
 */
const STOP_WORDS = new Set(
	(
		"a an the and or but of in on at to for from by with about as into over after before " +
		"i me my mine we our you your he him his she her it its they them their this that these those " +
		"is are was were be been am do does did have has had will would can could should " +
		"what when where which who whom whose why how not no so if than then there here"
	).split(" "),
);

/** The most alternatives and words a query is read for; models rarely write more. */
const MAX_ALTERNATIVES = 12;
const MAX_PARTS = 8;

/** A note as the index reads it. */
export interface SearchDocument {
	/** The note's text. */
	body: string;
	/** Its tags and the values of its properties, which count as words of the note. */
	extra: string;
}

/** One thing a query asks for: a word in any of its forms, or words standing together. */
type QueryPart =
	| { kind: "word"; text: string; term: string }
	| { kind: "phrase"; text: string; words: string[]; terms: string[] };

/** One way a query can be met; a note matching any alternative is found. */
export interface QueryAlternative {
	/** As written, for telling the model what was searched. */
	text: string;
	parts: QueryPart[];
}

/** A note a search found. */
export interface SearchHit {
	/** The note's place among the documents. */
	doc: number;
	score: number;
	/** Which of the query's alternatives it matches, by their place in the query. */
	matched: number[];
}

/** How many notes hold one part of a query, to say which word found nothing. */
export interface PartCount {
	text: string;
	notes: number;
	/** In so many notes that it was not searched for, beside rarer words. */
	common: boolean;
}

export interface AlternativeCount {
	text: string;
	notes: number;
	parts: PartCount[];
}

/** Where a query matches inside one note's text. */
export interface Located {
	start: number;
	end: number;
	/** Which part of the query it is, so an excerpt can prefer showing different ones. */
	part: number;
	weight: number;
}

export interface SearchResult {
	/** The notes found, best first. */
	hits: SearchHit[];
	counts: AlternativeCount[];
	/** Finds the query's matches in a note's text, for its excerpts. */
	locate: (body: string) => Located[];
}

interface Posting {
	docs: number[];
	weights: number[];
}

/** A word as it is compared: one case, no accents, one spelling of the letters that have two. */
function fold(word: string): string {
	return normalizeWord(word)
		.normalize("NFD")
		// Latin accents, Arabic short vowels and the stretch mark, and the joiner inside Persian words.
		.replace(/[̀-ًͯ-ْـ‌]/g, "")
		.replace(/[يى]/g, "ی")
		.replace(/ك/g, "ک")
		.normalize("NFC");
}

/** A word as the index keeps it: folded, and cut back to what its English forms share. */
export function termOf(word: string): string {
	const folded = fold(word);
	return stemWord(folded) || folded;
}

const wordsOf = (text: string): string[] => text.match(WORD) ?? [];

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A query's alternatives: split at `OR`, `|`, commas, semicolons and line breaks, outside quotes. */
function splitAlternatives(query: string): string[] {
	const pieces: string[] = [];
	let piece = "";
	let quoted = false;
	const text = query.replace(/\s+OR\s+/g, "|");
	for (const char of text) {
		if (char === '"' || char === "“" || char === "”") quoted = !quoted;
		if (!quoted && (char === "|" || char === "," || char === ";" || char === "\n")) {
			pieces.push(piece);
			piece = "";
		} else {
			piece += char;
		}
	}
	pieces.push(piece);
	return pieces;
}

/**
 * Reads a query as models write them: words, `"words that stand together"`,
 * and alternatives split by commas, `OR` or `|`. An `AND` between words is
 * dropped, since the words of one alternative are looked for together anyway.
 */
export function parseQuery(query: string): QueryAlternative[] {
	const alternatives: QueryAlternative[] = [];
	const seen = new Set<string>();
	for (const piece of splitAlternatives(query)) {
		const parts: QueryPart[] = [];
		const terms = new Set<string>();
		for (const match of piece.matchAll(/["“]([^"“”]+)["”]|([^\s"“”]+)/g)) {
			// Read well past the cap, which counts the words left once those that say nothing are gone.
			if (parts.length >= MAX_PARTS * 4) break;
			if (match[1] !== undefined) {
				const words = wordsOf(match[1]);
				const phrase = words.map(termOf);
				const text = match[1].replace(/\s+/g, " ").trim();
				if (phrase.length > 1) parts.push({ kind: "phrase", text, words, terms: phrase });
				else if (phrase.length === 1 && !terms.has(phrase[0])) {
					terms.add(phrase[0]);
					parts.push({ kind: "word", text, term: phrase[0] });
				}
				continue;
			}
			if (/^(AND|&&?|\+)$/.test(match[2])) continue;
			for (const word of wordsOf(match[2])) {
				const term = termOf(word);
				if (terms.has(term)) continue;
				terms.add(term);
				parts.push({ kind: "word", text: word, term });
			}
		}
		// What is left once the words that say nothing are gone, unless that is nothing.
		const telling = parts.filter((part) => part.kind !== "word" || !STOP_WORDS.has(part.text.toLowerCase()));
		if (telling.length) parts.splice(0, parts.length, ...telling);
		parts.splice(MAX_PARTS);
		const text = piece.replace(/\s+/g, " ").trim();
		const signature = parts.map((part) => (part.kind === "word" ? part.term : `"${part.terms.join(" ")}"`)).join(" ");
		if (!parts.length || seen.has(signature) || alternatives.length >= MAX_ALTERNATIVES) continue;
		seen.add(signature);
		alternatives.push({ text, parts });
	}
	return alternatives;
}

/** Where the sentences of a text start: after a full stop and its space, and on every new line. */
function sentenceStarts(text: string): number[] {
	const starts = [0];
	for (const match of text.matchAll(/[.!?…。！？؟]+["”’)\]]*\s+|\n+\s*/g)) starts.push(match.index + match[0].length);
	return starts;
}

/** The last of `sorted` that is at most `value`. */
function lastAtMost(sorted: readonly number[], value: number): number {
	let low = 0;
	let high = sorted.length - 1;
	while (low < high) {
		const middle = (low + high + 1) >> 1;
		if (sorted[middle] <= value) low = middle;
		else high = middle - 1;
	}
	return sorted[low];
}

/**
 * Up to `limit` stretches of `body` around what a search found in it, each
 * about `width` characters and one line long. A stretch starts with the
 * sentence the match is in and ends with a sentence where it can, so it reads
 * as the note does; the stretches holding the most different words of the
 * query are kept, in the note's order.
 */
export function excerptsOf(body: string, located: readonly Located[], limit: number, width: number): string[] {
	if (!located.length || limit < 1) return [];
	const starts = sentenceStarts(body);
	const windowFor = (match: Located): { start: number; end: number } => {
		const before = Math.floor(width * 0.4);
		let start = lastAtMost(starts, match.start);
		if (match.start - start > before) {
			start = match.start - before;
			const space = body.indexOf(" ", start);
			if (space !== -1 && space < match.start) start = space + 1;
		}
		let end = Math.min(body.length, Math.max(start + width, match.end));
		if (end < body.length) {
			// The last sentence that ends inside the window, or failing that the last word.
			const sentence = lastAtMost(starts, end);
			if (sentence > match.end) end = sentence;
			else {
				const space = body.lastIndexOf(" ", end);
				if (space > match.end) end = space;
			}
		}
		return { start, end };
	};
	const left = [...located].sort((first, second) => first.start - second.start);
	const chosen: Array<{ start: number; end: number }> = [];
	while (left.length && chosen.length < limit) {
		let best: { start: number; end: number; score: number } | null = null;
		for (const match of left) {
			const window = windowFor(match);
			const parts = new Map<number, number>();
			let inside = 0;
			for (const other of left) {
				if (other.start < window.start || other.end > window.end) continue;
				inside++;
				parts.set(other.part, Math.max(parts.get(other.part) ?? 0, other.weight));
			}
			let score = inside * 0.05;
			for (const weight of parts.values()) score += weight;
			if (!best || score > best.score) best = { ...window, score };
		}
		if (!best) break;
		const { start, end } = best;
		chosen.push({ start, end });
		// What the stretch already shows is not shown again by the next.
		for (let index = left.length - 1; index >= 0; index--) {
			if (left[index].start < end && left[index].end > start) left.splice(index, 1);
		}
	}
	chosen.sort((first, second) => first.start - second.start);
	const merged: Array<{ start: number; end: number }> = [];
	for (const window of chosen) {
		const last = merged[merged.length - 1];
		if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
		else merged.push({ ...window });
	}
	return merged.map(({ start, end }) => {
		const text = body.slice(start, end).replace(/\s+/g, " ").trim();
		const opens = starts.includes(start);
		const closes = end >= body.length || starts.includes(end);
		return `${opens ? "" : "…"}${text}${closes ? "" : "…"}`;
	});
}

/**
 * The journal's notes, indexed by their words for ranked search.
 *
 * Words are compared by their stems, so `run` finds `running`, without case
 * or accents; a longer word also finds the words that start with it, which
 * is what finds the forms of words in languages the stemmer does not know,
 * and the ones that share most of their start with it, as the spellings and
 * forms of one word do. Notes are ranked with BM25: a rare word counts for more
 * than a common one, and a note that keeps returning to a word for more than
 * one that mentions it once in passing.
 */
export class SearchIndex {
	private readonly documents: SearchDocument[] = [];
	private readonly postings = new Map<string, Posting>();
	private readonly lengths: number[] = [];
	/** The words in every note together, for the length of an average one. */
	private total = 0;
	/** Each note's words in order, as terms, worked out only for the notes a phrase is looked for in. */
	private readonly sequences = new Map<number, string[]>();

	/** Adds a note, and returns its place among the documents. */
	add(document: SearchDocument): number {
		const doc = this.documents.length;
		this.documents.push(document);
		const counts = new Map<string, number>();
		const words = wordsOf(document.body);
		for (const word of words) {
			const term = termOf(word);
			counts.set(term, (counts.get(term) ?? 0) + 1);
		}
		for (const word of wordsOf(document.extra)) {
			const term = termOf(word);
			counts.set(term, (counts.get(term) ?? 0) + EXTRA_WEIGHT);
		}
		for (const [term, weight] of counts) {
			let posting = this.postings.get(term);
			if (!posting) this.postings.set(term, (posting = { docs: [], weights: [] }));
			posting.docs.push(doc);
			posting.weights.push(weight);
		}
		this.lengths.push(words.length);
		this.total += words.length;
		return doc;
	}

	/**
	 * The notes matching any of `alternatives`, best first, among those
	 * `allowed` lets through. The words of one alternative are looked for
	 * together: a note with all of them ranks above one with some, and one
	 * where they stand together above both.
	 */
	search(alternatives: readonly QueryAlternative[], allowed: (doc: number) => boolean = () => true): SearchResult {
		const scores = new Map<number, { score: number; matched: number[] }>();
		const counts: AlternativeCount[] = [];
		/** The terms to mark in an excerpt, with the part of the query each stands for. */
		const marks = new Map<string, { part: number; weight: number }>();
		const phrases: Array<{ terms: string[]; part: number; weight: number }> = [];
		const patterns: Array<{ pattern: RegExp; part: number }> = [];
		let allowedCount = 0;
		for (let doc = 0; doc < this.documents.length; doc++) if (allowed(doc)) allowedCount++;
		const average = Math.max(1, this.total / Math.max(1, this.documents.length));
		let nextPart = 0;

		for (const alternative of alternatives) {
			const parts: QueryPart[] = [];
			const found: Array<Map<number, number>> = [];
			for (const part of alternative.parts) {
				const weights = this.find(part, allowed);
				if (part.kind === "word" || weights.size) {
					parts.push(part);
					found.push(weights);
					continue;
				}
				// Words that stand together nowhere are looked for apart: models quote out of habit.
				for (const [index, term] of part.terms.entries()) {
					if (parts.some((other) => other.kind === "word" && other.term === term)) continue;
					const word: QueryPart = { kind: "word", text: part.words[index], term };
					parts.push(word);
					found.push(this.find(word, allowed));
				}
			}
			const limit = Math.max(3, allowedCount * COMMON_SHARE);
			const rare = found.some((weights) => weights.size <= limit);
			const common = found.map((weights) => rare && found.length > 1 && weights.size > limit);
			const searched = found.filter((_, index) => !common[index]);
			const matched = new Map<number, { score: number; parts: number }>();
			for (const [index, weights] of found.entries()) {
				const part = nextPart++;
				if (common[index]) continue;
				const idf = Math.log(1 + (allowedCount - weights.size + 0.5) / (weights.size + 0.5));
				const queryPart = parts[index];
				if (queryPart.kind === "word") {
					for (const term of this.termsFor(queryPart.term)) marks.set(term.term, { part, weight: idf * term.weight });
				} else {
					phrases.push({ terms: queryPart.terms, part, weight: idf * queryPart.terms.length });
				}
				for (const [doc, weight] of weights) {
					const length = this.lengths[doc] / average;
					const score = (idf * weight * (K1 + 1)) / (weight + K1 * (1 - B + B * length));
					const entry = matched.get(doc) ?? { score: 0, parts: 0 };
					entry.score += score;
					entry.parts++;
					matched.set(doc, entry);
				}
			}
			let reported: PartCount[] = parts.map((part, index) => ({
				text: part.text,
				notes: found[index].size,
				common: common[index],
			}));
			// Words the index does not hold as words, such as part of one, or text without spaces.
			if (!matched.size) {
				const text = alternative.text.replace(/["“”]/g, "").trim();
				if (text.length >= 2) {
					const pattern = new RegExp(escapeRegExp(text).replace(/\s+/g, "\\s+"), "giu");
					const part = nextPart++;
					for (const [doc, document] of this.documents.entries()) {
						if (!allowed(doc)) continue;
						const times = document.body.match(pattern)?.length ?? 0;
						if (times) matched.set(doc, { score: Math.min(times, 5) * 0.5, parts: searched.length });
					}
					if (matched.size) {
						patterns.push({ pattern, part });
						// Found as text, not as its words, none of which the notes hold.
						reported = [{ text, notes: matched.size, common: false }];
					}
				}
			}
			const words = parts.flatMap((part, index) =>
				part.kind === "word" && !common[index] ? [part.term] : [],
			);
			for (const [doc, entry] of matched) {
				let score = entry.score;
				if (searched.length > 1) {
					score *= PARTIAL_FLOOR + (1 - PARTIAL_FLOOR) * (entry.parts / searched.length);
					if (entry.parts === searched.length && words.length > 1 && this.occurrences(doc, words)) score *= ADJACENT_BONUS;
				}
				const total = scores.get(doc) ?? { score: 0, matched: [] };
				total.score += score;
				total.matched.push(counts.length);
				scores.set(doc, total);
			}
			counts.push({ text: alternative.text, notes: matched.size, parts: reported });
		}

		const hits = [...scores]
			.map(([doc, { score, matched }]) => ({ doc, score, matched }))
			// The later note first among equals: what was written last is most often what is asked about.
			.sort((first, second) => second.score - first.score || second.doc - first.doc);
		const locate = (body: string): Located[] => {
			const located: Located[] = [];
			const tokens: Array<{ term: string; start: number; end: number }> = [];
			for (const match of body.matchAll(WORD)) {
				const term = termOf(match[0]);
				const start = match.index;
				tokens.push({ term, start, end: start + match[0].length });
				const mark = marks.get(term);
				if (mark) located.push({ start, end: start + match[0].length, ...mark });
			}
			for (const phrase of phrases) {
				for (let at = 0; at + phrase.terms.length <= tokens.length; at++) {
					if (!phrase.terms.every((term, offset) => tokens[at + offset].term === term)) continue;
					located.push({
						start: tokens[at].start,
						end: tokens[at + phrase.terms.length - 1].end,
						part: phrase.part,
						weight: phrase.weight,
					});
				}
			}
			for (const { pattern, part } of patterns) {
				pattern.lastIndex = 0;
				for (const match of body.matchAll(pattern)) {
					located.push({ start: match.index, end: match.index + match[0].length, part, weight: 1 });
				}
			}
			return located;
		};
		return { hits, counts, locate };
	}

	/**
	 * The terms a query word finds: its own, the ones that start with it when
	 * it is long enough, and the ones that share most of their start with it.
	 */
	private termsFor(term: string): Array<{ term: string; weight: number }> {
		const terms = this.postings.has(term) ? [{ term, weight: 1 }] : [];
		const length = term.length;
		const prefixes = length >= (/^[a-z']+$/.test(term) ? PREFIX_LENGTH : PREFIX_LENGTH_UNSTEMMED);
		if (!prefixes && length < KIN_LENGTH) return terms;
		for (const candidate of this.postings.keys()) {
			if (candidate === term) continue;
			if (prefixes && candidate.startsWith(term)) {
				terms.push({ term: candidate, weight: PREFIX_WEIGHT });
				continue;
			}
			if (length < KIN_LENGTH || candidate.length < KIN_LENGTH) continue;
			const shorter = Math.min(length, candidate.length);
			let shared = 0;
			while (shared < shorter && term[shared] === candidate[shared]) shared++;
			if (shared >= KIN_LENGTH && shared >= shorter * KIN_SHARE) terms.push({ term: candidate, weight: KIN_WEIGHT });
		}
		return terms;
	}

	/** The notes holding a part of a query, with how much of it each holds. */
	private find(part: QueryPart, allowed: (doc: number) => boolean): Map<number, number> {
		const weights = new Map<number, number>();
		if (part.kind === "word") {
			for (const { term, weight } of this.termsFor(part.term)) {
				const posting = this.postings.get(term);
				if (!posting) continue;
				for (const [index, doc] of posting.docs.entries()) {
					if (allowed(doc)) weights.set(doc, (weights.get(doc) ?? 0) + posting.weights[index] * weight);
				}
			}
			return weights;
		}
		// Words standing together: only the notes holding every one of them can.
		const [first, ...rest] = [...new Set(part.terms)].map((term) => this.postings.get(term));
		if (!first || rest.some((posting) => !posting)) return weights;
		const others = rest.map((posting) => new Set(posting?.docs));
		for (const doc of first.docs) {
			if (!allowed(doc) || !others.every((docs) => docs.has(doc))) continue;
			const times = this.occurrences(doc, part.terms);
			if (times) weights.set(doc, times);
		}
		return weights;
	}

	/** How often `terms` stand together, in order, in a note's text. */
	private occurrences(doc: number, terms: readonly string[]): number {
		let sequence = this.sequences.get(doc);
		if (!sequence) {
			sequence = wordsOf(this.documents[doc].body).map(termOf);
			this.sequences.set(doc, sequence);
		}
		let times = 0;
		for (let at = 0; at + terms.length <= sequence.length; at++) {
			if (terms.every((term, offset) => sequence[at + offset] === term)) times++;
		}
		return times;
	}
}
