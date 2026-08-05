export interface FindRange {
	from: number;
	to: number;
}

/** Returns non-overlapping literal matches in source order. */
export function findLiteralRanges(text: string, query: string, caseSensitive: boolean): FindRange[] {
	if (!query) return [];
	const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const expression = new RegExp(escaped, caseSensitive ? "gu" : "giu");
	const ranges: FindRange[] = [];
	for (const match of text.matchAll(expression)) {
		if (match.index === undefined) continue;
		ranges.push({ from: match.index, to: match.index + match[0].length });
	}
	return ranges;
}
