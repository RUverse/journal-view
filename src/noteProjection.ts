interface MarkdownLine {
	text: string;
	next: number;
}

export interface ProjectedNoteBody {
	hiddenPrefix: string | null;
	editorBody: string;
}

export interface MergedNoteBody {
	hiddenPrefix: string | null;
	body: string;
}

function markdownLineAt(value: string, start: number): MarkdownLine {
	let end = start;
	while (end < value.length && value.charCodeAt(end) !== 10 && value.charCodeAt(end) !== 13) end++;
	let next = end;
	if (next < value.length) {
		if (value.charCodeAt(next) === 13 && value.charCodeAt(next + 1) === 10) next++;
		next++;
	}
	return { text: value.slice(start, end), next };
}

function isMarkdownBlank(line: string): boolean {
	return /^[ \t]*$/.test(line);
}

/**
 * A deliberately conservative check for a one-line Setext title. Markdown
 * block constructs take priority over Setext headings, so ambiguous lines are
 * left visible instead of risking hiding content that is not a title.
 */
function isSetextTitle(line: string): boolean {
	if (isMarkdownBlank(line) || /^(?: {0,3}\t| {4})/.test(line)) return false;
	const text = line.replace(/^ {0,3}/, "");
	if (
		/^(?:#{1,6}(?:[ \t]|$)|>|`{3,}|~{3,}|<|\$\$|%%|[-+*](?:[ \t]+|$)|\d{1,9}[.)](?:[ \t]+|$)|\[[^\]]+\]:)/.test(
			text,
		)
	) {
		return false;
	}
	if (/^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|=+[ \t]*)$/.test(text)) return false;
	return true;
}

/** Splits a leading ATX or conservative Setext H1, with adjacent blank lines. */
export function splitLeadingH1(body: string): { hiddenPrefix: string; visibleBody: string } | null {
	let titleStart = 0;
	while (titleStart < body.length) {
		const line = markdownLineAt(body, titleStart);
		if (!isMarkdownBlank(line.text)) break;
		titleStart = line.next;
	}
	if (titleStart >= body.length) return null;

	const title = markdownLineAt(body, titleStart);
	let headingEnd = 0;
	if (/^ {0,3}#(?:[ \t]+.*)?[ \t]*$/.test(title.text)) {
		headingEnd = title.next;
	} else {
		const underline = markdownLineAt(body, title.next);
		if (
			title.next >= body.length ||
			!isSetextTitle(title.text) ||
			!/^ {0,3}=+[ \t]*$/.test(underline.text)
		) {
			return null;
		}
		headingEnd = underline.next;
	}

	while (headingEnd < body.length) {
		const line = markdownLineAt(body, headingEnd);
		if (!isMarkdownBlank(line.text)) break;
		headingEnd = line.next;
	}
	return { hiddenPrefix: body.slice(0, headingEnd), visibleBody: body.slice(headingEnd) };
}

/** CodeMirror stores every line break as `\n`, regardless of the file's EOL. */
export function normalizeEditorBody(body: string): string {
	return body.replace(/\r\n?/g, "\n");
}

export function projectNoteBody(body: string, hideDailyNoteH1: boolean): ProjectedNoteBody {
	const split = hideDailyNoteH1 ? splitLeadingH1(body) : null;
	return {
		hiddenPrefix: split?.hiddenPrefix ?? null,
		editorBody: normalizeEditorBody(split?.visibleBody ?? body),
	};
}

/**
 * Recombines an editor body only when the visible part of the latest vault
 * copy still matches the editor's base. The omission decision stays fixed for
 * editors that did not start with an H1. An editor that did omit one can safely
 * accept a title-only rename or removal while keeping visible-body conflicts.
 */
export function mergeProjectedNoteBody(
	latestBody: string,
	baseEditorBody: string,
	editorBody: string,
	hiddenPrefix: string | null,
): MergedNoteBody | null {
	const latest = hiddenPrefix === null ? null : splitLeadingH1(latestBody);
	const latestEditorBody = normalizeEditorBody(latest?.visibleBody ?? latestBody);
	if (latestEditorBody !== baseEditorBody) return null;

	const prefix = latest?.hiddenPrefix ?? null;
	const serializedPrefix = prefix ?? "";
	const separator = serializedPrefix && editorBody && !/[\r\n]$/.test(serializedPrefix) ? "\n" : "";
	return { hiddenPrefix: prefix, body: serializedPrefix + separator + editorBody };
}
