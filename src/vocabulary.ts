import { getFrontMatterInfo } from "obsidian";

const CHUNK_SIZE = 32768;

/** Block-quote markers, which code blocks inside a quote sit behind. */
const QUOTE = /^(?:[ \t]{0,3}>[ \t]?)*/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED = /^(?: {4}|\t)/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/;
const REFERENCE_DEFINITION = /^ {0,3}\[([^[\]\n]{1,500})\]:[ \t]*\S.*$/gm;
const BRACKETED = /\[([^[\]\n]{1,500})\]/g;

/**
 * Inline spans that are not prose, in the order they are blanked out: comments,
 * links of every kind, URLs, markup, tags, callout types, and block ids. Every
 * repetition that can fail partway is bounded and stops at the next opening
 * bracket, so no note can make a pattern retry over more than a short stretch:
 * a long run of brackets or letters stays linear rather than taking seconds.
 */
const NOT_PROSE: RegExp[] = [
	/<!--[\s\S]*?(?:-->|(?![\s\S]))/g,
	/%%[\s\S]*?(?:%%|(?![\s\S]))/g,
	// Wikilinks and embeds, alias and all.
	/!?\[\[[^[\]\n]{0,500}\]\]/g,
	// Markdown links and images, inline or by reference, text and all.
	/!?\[[^[\]\n]{0,500}\]\([^()\n]{0,2000}\)/g,
	/!?\[[^[\]\n]{0,500}\]\[[^[\]\n]{0,500}\]/g,
	/\[\^[^[\]\n]{1,100}\]/g,
	/<[a-z][a-z0-9+.-]{0,31}:[^<>\s]{0,2000}>/gi,
	/\b[a-z][a-z0-9+.-]{0,31}:\/\/\S+/gi,
	/\bwww\.\S+/gi,
	/<\/?[a-z][^<>\n]{0,500}>/gi,
	/(^|\s)#[^\s#]+/gm,
	/\[![^[\]\n]{0,64}\]/g,
	/(^|\s)\^[\w-]{1,64}[ \t]{0,16}$/gm,
];

/**
 * Blanks fenced and indented code blocks, inside block quotes too, a line at a
 * time. Indentation starts code only after a blank line that does not follow a
 * list item or other indented text, so nested list content stays prose.
 */
function blankCodeBlocks(text: string): string {
	const lines = text.split("\n");
	let fence = "";
	let fenceDepth = 0;
	let indented = false;
	let blankBefore = true;
	/** The last line with any text, which decides whether indentation starts code. */
	let lastText = "";
	for (const [at, line] of lines.entries()) {
		const quote = QUOTE.exec(line)?.[0] ?? "";
		const depth = quote.split(">").length - 1;
		const inner = line.slice(quote.length);
		const blank = !inner.trim();
		// A fence inside a quote also ends where the quote does.
		if (fence && depth >= fenceDepth) {
			const close = FENCE.exec(inner);
			if (close && close[1][0] === fence[0] && close[1].length >= fence.length && !inner.slice(close[0].length).trim()) {
				fence = "";
				lastText = inner;
				blankBefore = false;
			}
			lines[at] = "";
			continue;
		}
		fence = "";
		const open = FENCE.exec(inner);
		// A backtick fence's info string cannot hold a backtick; such a line is inline code.
		if (open && !(open[1][0] === "`" && inner.slice(open[0].length).includes("`"))) {
			fence = open[1];
			fenceDepth = depth;
			indented = false;
			lines[at] = "";
			continue;
		}
		if (!blank && INDENTED.test(inner) &&
			(indented || (blankBefore && !INDENTED.test(lastText) && !LIST_ITEM.test(lastText)))) {
			indented = true;
			lines[at] = "";
		} else if (!blank) {
			indented = false;
		}
		if (!blank) lastText = inner;
		blankBefore = blank;
	}
	return lines.join("\n");
}

/**
 * Blanks inline code: a run of backticks up to the next run of the same length
 * on its line. Each line's runs are paired in one pass, which a backreference
 * pattern cannot do in linear time.
 */
function blankInlineCode(line: string): string {
	if (!line.includes("`")) return line;
	const runs = Array.from(line.matchAll(/`+/g), (match) => ({ at: match.index ?? 0, length: match[0].length }));
	const next = new Array<number>(runs.length);
	const later = new Map<number, number>();
	for (let index = runs.length - 1; index >= 0; index--) {
		next[index] = later.get(runs[index].length) ?? -1;
		later.set(runs[index].length, index);
	}
	let result = "";
	let from = 0;
	for (let index = 0; index < runs.length;) {
		const close = next[index];
		if (close < 0) { index++; continue; }
		result += `${line.slice(from, runs[index].at)} `;
		from = runs[close].at + runs[close].length;
		index = close + 1;
	}
	return result + line.slice(from);
}

/**
 * A run of letters, marks, and digits, held together by an apostrophe or a
 * zero-width non-joiner, as in `don't` and the Persian `می‌روم`.
 */
const WORD = /[\p{L}\p{M}\p{N}]+(?:['’‌][\p{L}\p{M}\p{N}]+)*/gu;
const LETTER = /\p{L}/u;
/** Scripts written without spaces between words, such as Chinese, Japanese, and Thai. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
/** The platform's dictionary-based word breaker, where it has one. */
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;

/** A character a run can be cut before: not a mark, and not the second half of a surrogate pair. */
const CUT = /^[^\p{M}\udc00-\udfff]/u;

/**
 * A run matched by `WORD`, in pieces the segmenter can take one at a time. The
 * segmenter reads a whole run before giving its first word, so a run in a
 * script written without spaces is cut every `CHUNK_SIZE` characters or so.
 * Only a run with no punctuation at all gets that long, and a cut splits at
 * most one word in it.
 */
function piecesOf(run: string): string[] {
	if (!segmenter || run.length <= CHUNK_SIZE || !UNSPACED.test(run)) return [run];
	const pieces: string[] = [];
	for (let start = 0; start < run.length;) {
		let end = Math.min(run.length, start + CHUNK_SIZE);
		while (end < run.length && !CUT.test(run.slice(end, end + 2))) end++;
		pieces.push(run.slice(start, end));
		start = end;
	}
	return pieces;
}

/** One spelling for a word however it was typed: composed, lowercase, straight apostrophe. */
export function normalizeWord(word: string): string {
	return word.normalize("NFC").toLowerCase().replace(/’/g, "'");
}

/**
 * The note body with code, comments, links, tags, and markup blanked out, each
 * replaced by a space so the words on either side stay apart. Code goes first,
 * so a link inside it is not mistaken for one.
 */
export function proseOf(content: string): string {
	let text = blankCodeBlocks(content.slice(getFrontMatterInfo(content).contentStart));
	text = text.split("\n").map(blankInlineCode).join("\n");
	// Reference definitions name the labels that shortcut links like `[label]` use.
	const labels = new Set<string>();
	text = text.replace(REFERENCE_DEFINITION, (_line, label: string) => {
		labels.add(label.toLowerCase());
		return " ";
	});
	for (const pattern of NOT_PROSE) text = text.replace(pattern, " ");
	if (labels.size) text = text.replace(BRACKETED, (match, label: string) => labels.has(label.toLowerCase()) ? " " : match);
	// Email addresses and handles: any whitespace-separated token with an @.
	return text.replace(/\S+/g, (token) => token.includes("@") ? " " : token);
}

/**
 * The distinct words of a note's prose, normalized. A word needs a letter, so
 * plain numbers are left out.
 *
 * A run holding a script written without spaces is a whole phrase, so the
 * segmenter splits it into words; any other run is a word already, and is left
 * alone so spaced languages keep their words. The segmenter takes a slice's
 * runs in one call, a line break apart, since it always breaks there.
 *
 * Matching yields every `CHUNK_SIZE` characters or so, wherever the text has
 * got to, so a very large note does not block the UI, even one long paragraph
 * without spaces.
 */
export async function noteWords(content: string, current: () => boolean): Promise<Set<string> | null> {
	const text = proseOf(content);
	const words = new Set<string>();
	const add = (word: string) => {
		if (LETTER.test(word)) words.add(normalizeWord(word));
	};
	let unspaced: string[] = [];
	const segment = () => {
		if (!segmenter || !unspaced.length) return;
		for (const part of segmenter.segment(unspaced.join("\n"))) {
			if (part.isWordLike) add(part.segment);
		}
		unspaced = [];
	};
	if (!current()) return null;
	let paused = 0;
	for (const match of text.matchAll(WORD)) {
		let end = match.index ?? 0;
		for (const piece of piecesOf(match[0])) {
			if (segmenter && UNSPACED.test(piece)) unspaced.push(piece);
			else add(piece);
			end += piece.length;
			if (end - paused >= CHUNK_SIZE && end < text.length) {
				segment();
				await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
				if (!current()) return null;
				paused = end;
			}
		}
	}
	segment();
	return words;
}

/** Words the stemmer would otherwise merge with another word, or cut short. */
const STEM_EXCEPTIONS: Record<string, string> = {
	skis: "ski", skies: "sky", dying: "die", lying: "lie", tying: "tie",
	sky: "sky", news: "news", howe: "howe", atlas: "atlas", cosmos: "cosmos", bias: "bias", andes: "andes",
};
/** Words left alone once a plural ending is gone, so `-ing` and `-eed` stay. */
const STEM_KEEP = new Set(["inning", "outing", "canning", "herring", "earring", "proceed", "exceed", "succeed"]);

/** Where the region after the first consonant that follows a vowel begins, from `start`. */
function stemRegion(word: string, start = 0): number {
	const prefix = start ? null : /^(gener|commun|arsen)/.exec(word);
	if (prefix) return prefix[0].length;
	const match = /[aeiouy][^aeiouy]/.exec(word.slice(start));
	return match ? start + match.index + 2 : word.length;
}

/** A short syllable ends `word`: `hop`, or a two-letter word such as `us`. */
function endsShortSyllable(word: string): boolean {
	return /^[aeiouy][^aeiouy]$/.test(word) || /[^aeiouy][aeiouy][^aeiouywxY]$/.test(word);
}

/** A word whose region is empty and which ends in a short syllable, like `hop`. */
function isShortStem(word: string): boolean {
	return stemRegion(word) >= word.length && endsShortSyllable(word);
}

/**
 * The stem shared by an English word's inflected forms, so `portraits` counts
 * as `portrait` and `walked` as `walk`. These are the Snowball English
 * stemmer's inflection steps: possessives, plurals, `-ed`, `-ing`, a final `y`
 * (steps 0 to 1c), and a silent final `e` (from step 5). Steps 2 to 4, which
 * strip derivational endings, would merge words such as `general` and
 * `generate`, so they are left out. Only words of plain a-z
 * letters are stemmed; any other word is its own stem.
 */
export function stemWord(word: string): string {
	if (!/^[a-z']+$/.test(word)) return word;
	let stem = word.replace(/^'/, "");
	if (stem.length <= 2) return word;
	if (stem in STEM_EXCEPTIONS) return STEM_EXCEPTIONS[stem];
	stem = stem.replace(/'s'$|'s$|'$/, "");
	if (!stem) return word;
	// A y that acts as a consonant is marked Y, which the vowel classes leave out.
	stem = stem.replace(/^y/, "Y").replace(/([aeiouy])y/g, "$1Y");

	if (stem.endsWith("sses")) stem = stem.slice(0, -2);
	else if (/ie[ds]$/.test(stem)) stem = stem.slice(0, stem.length > 4 ? -2 : -1);
	else if (stem.endsWith("s") && !/(us|ss)$/.test(stem) && /[aeiouy]/.test(stem.slice(0, -2))) stem = stem.slice(0, -1);
	if (STEM_KEEP.has(stem)) return stem;

	const eed = /(eedly|eed)$/.exec(stem);
	const ending = eed ? null : /(ingly|edly|ing|ed)$/.exec(stem);
	if (eed) {
		if (eed.index >= stemRegion(stem)) stem = `${stem.slice(0, eed.index)}ee`;
	} else if (ending && /[aeiouy]/.test(stem.slice(0, ending.index))) {
		stem = stem.slice(0, ending.index);
		if (/(at|bl|iz)$/.test(stem)) stem += "e";
		else if (/(bb|dd|ff|gg|mm|nn|pp|rr|tt)$/.test(stem)) stem = stem.slice(0, -1);
		else if (isShortStem(stem)) stem += "e";
	}

	stem = stem.replace(/(.[^aeiouy])[yY]$/, "$1i");

	// Step 5's final e, so `dance` meets `danced` at `danc`, and `boxes` meets
	// `box`: an e in R2 goes, as does one in R1 not after a short syllable.
	if (stem.endsWith("e")) {
		const r1 = stemRegion(stem);
		const at = stem.length - 1;
		if (at >= stemRegion(stem, r1) || (at >= r1 && !endsShortSyllable(stem.slice(0, -1)))) stem = stem.slice(0, -1);
	}
	return stem.replace(/Y/g, "y");
}
