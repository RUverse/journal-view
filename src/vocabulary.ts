import { getFrontMatterInfo } from "obsidian";

const CHUNK_SIZE = 32768;

/**
 * Spans that are not prose, in the order they are blanked out: code first, so
 * a link inside it is not mistaken for one, then comments, links of every kind,
 * tags, and markup. Each is replaced by a space, which keeps the words on either
 * side apart.
 */
const NOT_PROSE: RegExp[] = [
	// Fenced code, running to the end of the note when the fence is never closed.
	/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm,
	// Inline code, on one line.
	/(`+)[^\n]*?\1/g,
	/<!--[\s\S]*?(?:-->|(?![\s\S]))/g,
	/%%[\s\S]*?(?:%%|(?![\s\S]))/g,
	// Wikilinks and embeds, alias and all.
	/!?\[\[[^\]\n]*\]\]/g,
	// Markdown links and images, text and all.
	/!?\[[^\]\n]*\]\([^)\n]*\)/g,
	/<[a-z][a-z0-9+.-]*:[^>\s]*>/gi,
	/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,
	/\bwww\.\S+/gi,
	/[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[^\s@<>()[\]]+/g,
	/<\/?[a-z][^>\n]*>/gi,
	// Tags, callout types, and block ids.
	/(^|\s)#[^\s#]+/gm,
	/\[![^\]\n]*\]/g,
	/(^|\s)\^[\w-]+[ \t]*$/gm,
];

/**
 * A run of letters, marks, and digits, held together by an apostrophe or a
 * zero-width non-joiner, as in `don't` and the Persian `می‌روم`.
 */
const WORD = /[\p{L}\p{M}\p{N}]+(?:['’‌][\p{L}\p{M}\p{N}]+)*/gu;
const LETTER = /\p{L}/u;

/** One spelling for a word however it was typed: composed, lowercase, straight apostrophe. */
export function normalizeWord(word: string): string {
	return word.normalize("NFC").toLowerCase().replace(/’/g, "'");
}

/** The note body with code, comments, links, tags, and markup blanked out. */
export function proseOf(content: string): string {
	let text = content.slice(getFrontMatterInfo(content).contentStart);
	for (const pattern of NOT_PROSE) text = text.replace(pattern, " ");
	return text;
}

/**
 * The distinct words of a note's prose, normalized. A word needs a letter, so
 * plain numbers are left out. Matching runs in bounded slices cut at
 * whitespace, yielding between them so a very large note does not block the UI.
 */
export async function noteWords(content: string, current: () => boolean): Promise<Set<string> | null> {
	const text = proseOf(content);
	const words = new Set<string>();
	for (let offset = 0; offset < text.length;) {
		if (!current()) return null;
		let end = Math.min(text.length, offset + CHUNK_SIZE);
		while (end < text.length && !/\s/.test(text[end])) end++;
		for (const match of text.slice(offset, end).matchAll(WORD)) {
			if (LETTER.test(match[0])) words.add(normalizeWord(match[0]));
		}
		offset = end;
		if (offset < text.length) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	}
	return words;
}

/** Words the stemmer would otherwise merge with another word, or cut short. */
const STEM_EXCEPTIONS: Record<string, string> = {
	skis: "ski", skies: "sky", dying: "die", lying: "lie", tying: "tie",
	sky: "sky", news: "news", howe: "howe", atlas: "atlas", cosmos: "cosmos", bias: "bias", andes: "andes",
};
/** Words left alone once a plural ending is gone, so `-ing` and `-eed` stay. */
const STEM_KEEP = new Set(["inning", "outing", "canning", "herring", "earring", "proceed", "exceed", "succeed"]);

/** Where the region after the first consonant that follows a vowel begins. */
function stemRegion(word: string): number {
	const prefix = /^(gener|commun|arsen)/.exec(word);
	if (prefix) return prefix[0].length;
	const match = /[aeiouy][^aeiouy]/.exec(word);
	return match ? match.index + 2 : word.length;
}

/** A word whose region is empty and which ends in a short syllable, like `hop`. */
function isShortStem(word: string): boolean {
	return stemRegion(word) >= word.length &&
		(/^[aeiouy][^aeiouy]$/.test(word) || /[^aeiouy][aeiouy][^aeiouywxY]$/.test(word));
}

/**
 * The stem shared by an English word's inflected forms, so `portraits` counts
 * as `portrait` and `walked` as `walk`. These are steps 0 to 1c of the Snowball
 * English stemmer: possessives, plurals, `-ed`, `-ing`, and a final `y`. Its
 * later steps, which strip derivational endings, would merge words such as
 * `general` and `generate`, so they are left out. Only words of plain a-z
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
	// Not part of the Snowball step, whose final-e step would join `boxe` to
	// `box`: plurals in -es after x, ch, sh, and zz. Not after s or z, as in
	// `horses` and `sizes`.
	else if (/(x|ch|sh|zz)es$/.test(stem)) stem = stem.slice(0, -2);
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
	return stem.replace(/Y/g, "y");
}
