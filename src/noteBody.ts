import { getFrontMatterInfo } from "obsidian";

/**
 * The journal edits only the note body. Obsidian's parser locates frontmatter
 * so it can be preserved exactly rather than parsed and serialized again.
 */
export function noteBody(content: string): string {
	return content.slice(getFrontMatterInfo(content).contentStart);
}

/**
 * CodeMirror stores every line break as `\n`, regardless of the file's EOL.
 * Find reads unloaded notes through this too, so an offset found in one still
 * points at the same text once the note is open in an editor.
 */
export function editorBody(content: string): string {
	return noteBody(content).replace(/\r\n?/g, "\n");
}
