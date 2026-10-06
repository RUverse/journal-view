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
