import { App, TFile, getAllTags } from "obsidian";
import type { CachedMetadata } from "obsidian";
import type { DailyNoteIndex, OrderedDayIndex } from "./noteIndex";
import type {
	JournalFilterMode,
	JournalFilterRule,
	JournalFilterValue,
	JournalViewSettings,
} from "./settings";

/** Removes Obsidian's display prefix and produces the comparison form of a tag. */
export function normalizeFilterTag(value: string): string {
	return value.trim().replace(/^#+/, "").replace(/\/+$/g, "").toLocaleLowerCase();
}

export function isFilterActive(settings: JournalViewSettings): boolean {
	return settings.filterRules.length > 0;
}

function isFilterMode(value: unknown): value is JournalFilterMode {
	return value === "include" || value === "exclude";
}

function isFilterValue(value: unknown): value is JournalFilterValue {
	return (
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

/** Validates persisted rules while normalising the identifiers used for matching. */
export function filterRulesSetting(value: unknown): JournalFilterRule[] {
	if (!Array.isArray(value)) return [];
	const rules: JournalFilterRule[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const candidate = item as Record<string, unknown>;
		if (!isFilterMode(candidate.mode)) continue;
		if (candidate.kind === "tag" && typeof candidate.tag === "string") {
			const tag = normalizeFilterTag(candidate.tag);
			if (tag) rules.push({ kind: "tag", mode: candidate.mode, tag });
			continue;
		}
		if (
			candidate.kind === "property" &&
			typeof candidate.property === "string" &&
			isFilterValue(candidate.value)
		) {
			const property = candidate.property.trim();
			if (property && !["tags", "position"].includes(property.toLocaleLowerCase())) {
				rules.push({ kind: "property", mode: candidate.mode, property, value: candidate.value });
			}
		}
	}
	return dedupeFilterRules(rules);
}

export function sameFilterValue(left: JournalFilterValue, right: JournalFilterValue): boolean {
	return typeof left === typeof right && left === right;
}

export function sameFilterRule(left: JournalFilterRule, right: JournalFilterRule): boolean {
	if (left.kind !== right.kind || left.mode !== right.mode) return false;
	if (left.kind === "tag" && right.kind === "tag") return left.tag === right.tag;
	return (
		left.kind === "property" &&
		right.kind === "property" &&
		left.property.toLocaleLowerCase() === right.property.toLocaleLowerCase() &&
		sameFilterValue(left.value, right.value)
	);
}

function dedupeFilterRules(rules: JournalFilterRule[]): JournalFilterRule[] {
	const result: JournalFilterRule[] = [];
	for (const rule of rules) {
		if (!result.some((current) => sameFilterRule(current, rule))) result.push(rule);
	}
	return result;
}

function tagMatches(candidate: string, filter: string): boolean {
	const tag = normalizeFilterTag(candidate);
	return tag === filter || tag.startsWith(`${filter}/`);
}

function propertyValueMatches(stored: unknown, expected: JournalFilterValue): boolean {
	if (Array.isArray(stored)) {
		return stored.some((item) => isFilterValue(item) && sameFilterValue(item, expected));
	}
	return isFilterValue(stored) && sameFilterValue(stored, expected);
}

function ruleMatches(cache: CachedMetadata | null, rule: JournalFilterRule): boolean {
	if (rule.kind === "tag") {
		return (getAllTags(cache ?? {}) ?? []).some((tag) => tagMatches(tag, rule.tag));
	}

	const frontmatter = cache?.frontmatter;
	if (!frontmatter) return false;
	const expected = rule.property.toLocaleLowerCase();
	const actual = Object.keys(frontmatter).find((key) => key.toLocaleLowerCase() === expected);
	return actual !== undefined && propertyValueMatches(frontmatter[actual], rule.value);
}

/** Existing notes match every include rule unless an exclude rule vetoes them. */
export function matchesFilterRules(cache: CachedMetadata | null, rules: JournalFilterRule[]): boolean {
	for (const rule of rules) {
		const matches = ruleMatches(cache, rule);
		if (rule.mode === "include" && !matches) return false;
		if (rule.mode === "exclude" && matches) return false;
	}
	return true;
}

/**
 * Ordered projection of the daily-note index containing only notes accepted by
 * the metadata rules. It stays separate from existence so empty-day visibility
 * can remain an independent setting.
 */
export class FilteredDailyNoteIndex implements OrderedDayIndex {
	private keys = new Set<string>();
	private sorted: string[] = [];
	private sortedDirty = true;
	private matchingPaths = new Set<string>();
	private pathKeys = new Map<string, string>();
	private matchingCounts = new Map<string, number>();
	private signature = "";
	private baseVersion = -1;

	version = 0;

	constructor(
		private app: App,
		private base: DailyNoteIndex,
		private getRules: () => JournalFilterRule[],
	) {}

	rebuild(): void {
		this.base.ensureCurrent();
		this.keys.clear();
		this.matchingPaths.clear();
		this.pathKeys.clear();
		this.matchingCounts.clear();
		const rules = this.getRules();
		const config = this.base.resolvedConfig();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const key = this.base.keyForPath(file.path, config);
			if (!key) continue;
			this.pathKeys.set(file.path, key);
			if (!matchesFilterRules(this.app.metadataCache.getFileCache(file), rules)) continue;
			this.matchingPaths.add(file.path);
			this.matchingCounts.set(key, (this.matchingCounts.get(key) ?? 0) + 1);
			this.keys.add(key);
		}
		this.signature = JSON.stringify(rules);
		this.baseVersion = this.base.version;
		this.sortedDirty = true;
		this.version++;
	}

	ensureCurrent(): void {
		this.base.ensureCurrent();
		if (this.base.version !== this.baseVersion || JSON.stringify(this.getRules()) !== this.signature) {
			this.rebuild();
		}
	}

	/** Re-evaluates one note after Obsidian has refreshed its metadata cache. */
	handleMetadataChange(file: TFile): boolean {
		this.ensureCurrent();
		const key = this.base.keyForPath(file.path);
		const previousKey = this.pathKeys.get(file.path);
		let membershipChanged = false;
		if (previousKey && previousKey !== key) {
			membershipChanged = this.removeMatchingPath(file.path, previousKey);
		}
		if (!key) {
			this.pathKeys.delete(file.path);
			if (membershipChanged) {
				this.sortedDirty = true;
				this.version++;
			}
			return membershipChanged;
		}

		this.pathKeys.set(file.path, key);
		const wasMatching = this.matchingPaths.has(file.path);
		const matches = matchesFilterRules(this.app.metadataCache.getFileCache(file), this.getRules());
		if (matches === wasMatching && previousKey === key) return false;
		if (wasMatching) membershipChanged = this.removeMatchingPath(file.path, previousKey ?? key) || membershipChanged;
		if (matches) {
			this.addMatchingPath(file.path, key);
			membershipChanged = true;
		}
		if (membershipChanged) {
			this.sortedDirty = true;
			this.version++;
		}
		return membershipChanged;
	}

	has(key: string): boolean {
		return this.keys.has(key);
	}

	get size(): number {
		return this.keys.size;
	}

	range(): { first: string; last: string } | null {
		const list = this.list();
		return list.length ? { first: list[0], last: list[list.length - 1] } : null;
	}

	next(key: string): string | null {
		const list = this.list();
		let low = 0;
		let high = list.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (list[mid] <= key) low = mid + 1;
			else high = mid;
		}
		return low < list.length ? list[low] : null;
	}

	prev(key: string): string | null {
		const list = this.list();
		let low = 0;
		let high = list.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (list[mid] < key) low = mid + 1;
			else high = mid;
		}
		return low > 0 ? list[low - 1] : null;
	}

	keysFrom(key: string, direction: -1 | 1): string[] {
		const list = this.list();
		if (direction > 0) {
			return [...list.filter((candidate) => candidate > key), ...list.filter((candidate) => candidate < key)];
		}
		return [
			...list.filter((candidate) => candidate < key).reverse(),
			...list.filter((candidate) => candidate > key).reverse(),
		];
	}

	private addMatchingPath(path: string, key: string): void {
		this.matchingPaths.add(path);
		const count = (this.matchingCounts.get(key) ?? 0) + 1;
		this.matchingCounts.set(key, count);
		if (count === 1) this.keys.add(key);
	}

	private removeMatchingPath(path: string, key: string): boolean {
		if (!this.matchingPaths.delete(path)) return false;
		const count = (this.matchingCounts.get(key) ?? 1) - 1;
		if (count > 0) this.matchingCounts.set(key, count);
		else {
			this.matchingCounts.delete(key);
			this.keys.delete(key);
		}
		return true;
	}

	private list(): string[] {
		if (this.sortedDirty) {
			this.sorted = Array.from(this.keys).sort();
			this.sortedDirty = false;
		}
		return this.sorted;
	}
}
