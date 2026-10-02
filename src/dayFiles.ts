import { App, TAbstractFile, TFile } from "obsidian";
import type { DailyNoteResolver, ResolvedDailyConfig } from "./dailyNotes";
import { ISO_8601, createMoment } from "./moment";
import { keyAfter, keyBefore } from "./noteIndex";
import type { DailyNoteIndex, DaySequence } from "./noteIndex";
import type { DayFilesDate, JournalViewSettings } from "./settings";

/** Notes, canvases and bases are always listed; any other file is an attachment. */
const LISTED_EXTENSIONS = new Set(["md", "canvas", "base"]);

const fileNames = new Intl.Collator(undefined, { numeric: true });

/** How a file came to be listed under a day. */
export type DayFileKind = "created" | "edited";

/** One file listed under a day. */
export interface DayFile {
	file: TFile;
	kind: DayFileKind;
	/** When the file was created or edited, which orders the list. */
	time: number;
	/** False when only the date is known, from a property without a time. */
	timed: boolean;
}

interface PlacedFile extends DayFile {
	key: string;
}

/** A moment a file is dated to, and the day it falls on. */
interface Dated {
	key: string;
	time: number;
	timed: boolean;
}

/** Everything that decides which files are listed, and under which day. */
interface Rules {
	date: DayFilesDate;
	property: string;
	attachments: boolean;
	/** Folders whose files are left out, each ending in `/`. */
	excluded: string[];
	/** The daily-note template, which is not a file of the day it was copied on. */
	template: string;
	config: ResolvedDailyConfig;
}

function pad(value: number, length = 2): string {
	return String(value).padStart(length, "0");
}

/**
 * The local day a timestamp falls on, as a `YYYY-MM-DD` key. A vault's files
 * cluster on the same days, so the last day worked out is kept and its
 * bounds checked before any date arithmetic.
 */
const dayKey = (() => {
	let start = 0;
	let end = 0;
	let key = "";
	return (time: number): string => {
		if (time >= start && time < end) return key;
		const date = new Date(time);
		start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
		end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
		key = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
		return key;
	};
})();

function asFolder(path: string): string {
	const folder = path.replace(/^\/+|\/+$/g, "").trim();
	return folder ? `${folder}/` : "";
}

/** How Obsidian writes date and date & time properties, which is read without Moment. */
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** The date a note's property holds, if it holds one. */
function propertyDate(value: unknown): Dated | null {
	const first: unknown = Array.isArray(value) ? value[0] : value;
	if (first instanceof Date) return datedAt(first.getTime());
	if (typeof first !== "string") return null;
	const text = first.trim();
	const local = LOCAL_DATE.exec(text);
	if (local) {
		const [, year, month, day, hour, minute, second] = local;
		const date = new Date(+year, +month - 1, +day, +(hour ?? 0), +(minute ?? 0), +(second ?? 0));
		// Rolled over, as 2026-02-30 would be: not a date at all.
		if (date.getDate() !== +day || date.getMonth() !== +month - 1) return null;
		return { key: `${year}-${month}-${day}`, time: date.getTime(), timed: hour !== undefined };
	}
	// Anything else ISO 8601 allows, such as a time zone, costs a Moment parse.
	const parsed = createMoment(text, ISO_8601, true);
	return parsed.isValid() ? datedAt(parsed.valueOf(), /\d:\d/.test(text)) : null;
}

function datedAt(time: number, timed = true): Dated | null {
	return Number.isNaN(time) ? null : { key: dayKey(time), time, timed };
}

function samePlacements(left: PlacedFile[], right: PlacedFile[]): boolean {
	return (
		left.length === right.length &&
		left.every(
			(placed, index) =>
				placed.key === right[index].key &&
				placed.kind === right[index].kind &&
				placed.time === right[index].time &&
				placed.timed === right[index].timed,
		)
	);
}

function compareFiles(left: DayFile, right: DayFile): number {
	return left.time - right.time || fileNames.compare(left.file.path, right.file.path);
}

/**
 * The files from each day that are not daily notes: what was created, or
 * last edited, on that day. Everything it reads - file dates, and the
 * property a note can carry its created date in - is already in memory, so a
 * scan never touches the disk. It only holds anything while the lists are
 * shown, and follows the vault from there one file at a time.
 */
export class DayFileIndex implements DaySequence {
	private days = new Map<string, DayFile[]>();
	/** Where each listed file is: one day, or two when created and edited on different days. */
	private placed = new Map<string, PlacedFile[]>();
	private sorted: string[] = [];
	private sortedDirty = true;
	/** The rules of the last scan; null while the lists are off. */
	private active: Rules | null = null;
	/** What the last scan was made against; null until the first. */
	private signature: string | null = null;
	private listeners = new Set<(keys: string[] | null) => void>();

	/** Bumped on every change, so views can tell when to look again. */
	version = 0;

	constructor(
		private app: App,
		private notes: DailyNoteIndex,
		private daily: DailyNoteResolver,
		private getSettings: () => JournalViewSettings,
	) {}

	/** Hears which days' files changed, or null when any day's may have. */
	onChanged(listener: (keys: string[] | null) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	rebuild(): void {
		const rules = this.rules();
		this.days.clear();
		this.placed.clear();
		if (rules) {
			for (const file of this.app.vault.getFiles()) this.add(this.placementsFor(file, rules), null);
			// Sorted once at the end: a vault's files mostly arrive oldest first,
			// which would have every insertion walk its whole day.
			for (const files of this.days.values()) files.sort(compareFiles);
		}
		this.active = rules;
		this.signature = this.signatureOf(rules);
		this.sortedDirty = true;
		this.version++;
	}

	/** Scans again if anything that decides the lists moved since the last scan. */
	ensureCurrent(): boolean {
		if (this.signature === this.signatureOf(this.rules())) return false;
		this.rebuild();
		this.announce(null);
		return true;
	}

	/** Places a file again after it was created, edited, or renamed from `oldPath`. */
	update(file: TAbstractFile, oldPath?: string): void {
		if (this.signature === null || this.ensureCurrent() || !this.active) return;
		const changed = new Set<string>();
		if (oldPath !== undefined && oldPath !== file.path) this.take(oldPath, changed);
		if (file instanceof TFile) {
			const next = this.placementsFor(file, this.active);
			if (!samePlacements(this.placed.get(file.path) ?? [], next)) {
				this.take(file.path, changed);
				this.add(next, changed);
			}
		}
		this.announce(changed);
	}

	remove(path: string): void {
		if (this.signature === null || this.ensureCurrent()) return;
		const changed = new Set<string>();
		this.take(path, changed);
		this.announce(changed);
	}

	/** The files listed under a day, oldest first. */
	filesFor(key: string): readonly DayFile[] {
		return this.days.get(key) ?? [];
	}

	has(key: string): boolean {
		return this.days.has(key);
	}

	range(): { first: string; last: string } | null {
		const list = this.list();
		return list.length ? { first: list[0], last: list[list.length - 1] } : null;
	}

	next(key: string): string | null {
		return keyAfter(this.list(), key);
	}

	prev(key: string): string | null {
		return keyBefore(this.list(), key);
	}

	/* ---------------------------------------------------------------- rules */

	private rules(): Rules | null {
		const settings = this.getSettings();
		if (!settings.showDayFiles) return null;
		const config = this.daily.config();
		const excluded = settings.dayFilesExcluded.split(",").map(asFolder);
		excluded.push(...this.templateFolders().map(asFolder));
		return {
			date: settings.dayFilesDate,
			property: settings.dayFilesProperty.trim().toLocaleLowerCase(),
			attachments: settings.dayFilesAttachments,
			excluded: excluded.filter(Boolean),
			template: config.template ? (config.template.endsWith(".md") ? config.template : `${config.template}.md`) : "",
			config,
		};
	}

	private signatureOf(rules: Rules | null): string {
		if (!rules) return "off";
		// Obsidian's excluded files are asked about file by file, so a change
		// to them has to be noticed here.
		let ignored: unknown = null;
		try {
			ignored = this.app.vault.getConfig?.("userIgnoreFilters") ?? null;
		} catch {
			// An internal setting; the lists work without it.
		}
		return JSON.stringify([rules, ignored]);
	}

	/** Folders holding templates, for the core Templates plugin and Templater. */
	private templateFolders(): string[] {
		const folders: string[] = [];
		try {
			const core = this.app.internalPlugins?.getPluginById("templates")?.instance?.options?.folder;
			if (core) folders.push(core);
			const templater = this.app.plugins?.getPlugin("templater-obsidian") as
				| { settings?: { templates_folder?: unknown } }
				| null
				| undefined;
			const folder = templater?.settings?.templates_folder;
			if (typeof folder === "string" && folder) folders.push(folder);
		} catch (error) {
			console.warn("Journal View: could not read the templates folder", error);
		}
		return folders;
	}

	private lists(file: TFile, rules: Rules): boolean {
		if (!rules.attachments && !LISTED_EXTENSIONS.has(file.extension)) return false;
		if (file.path === rules.template) return false;
		if (rules.excluded.some((folder) => file.path.startsWith(folder))) return false;
		if (file.extension === "md" && this.notes.keyForPath(file.path, rules.config) !== null) return false;
		try {
			return !this.app.metadataCache.isUserIgnored?.(file.path);
		} catch {
			return true;
		}
	}

	/** When a file was created: from its property if it has one, otherwise from the file system. */
	private createdAt(file: TFile, rules: Rules): Dated {
		if (rules.property && file.extension === "md") {
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const name = frontmatter && Object.keys(frontmatter).find((key) => key.toLocaleLowerCase() === rules.property);
			const date = name ? propertyDate(frontmatter[name]) : null;
			if (date) return date;
		}
		return { key: dayKey(file.stat.ctime), time: file.stat.ctime, timed: true };
	}

	/** The days a file is listed under, and as what. */
	private placementsFor(file: TFile, rules: Rules): PlacedFile[] {
		if (!this.lists(file, rules)) return [];
		const placed: PlacedFile[] = [];
		const created = rules.date === "modified" ? null : this.createdAt(file, rules);
		if (created) placed.push({ file, kind: "created", ...created });
		if (rules.date === "created") return placed;
		const edited = file.stat.mtime;
		const editedKey = dayKey(edited);
		if (editedKey !== created?.key) placed.push({ file, kind: "edited", key: editedKey, time: edited, timed: true });
		return placed;
	}

	/* ---------------------------------------------------------------- lists */

	/** Lists a file under its days: in order, or at the end for a scan that sorts afterwards (`changed` null). */
	private add(placements: PlacedFile[], changed: Set<string> | null): void {
		if (!placements.length) return;
		this.placed.set(placements[0].file.path, placements);
		for (const placed of placements) {
			const files = this.days.get(placed.key);
			if (!files) {
				this.days.set(placed.key, [placed]);
				this.sortedDirty = true;
			} else if (!changed) {
				files.push(placed);
			} else {
				let low = 0;
				let high = files.length;
				while (low < high) {
					const mid = (low + high) >> 1;
					if (compareFiles(files[mid], placed) <= 0) low = mid + 1;
					else high = mid;
				}
				files.splice(low, 0, placed);
			}
			changed?.add(placed.key);
		}
	}

	private take(path: string, changed: Set<string>): void {
		const placements = this.placed.get(path);
		if (!placements) return;
		this.placed.delete(path);
		for (const placed of placements) {
			const files = this.days.get(placed.key);
			if (!files) continue;
			changed.add(placed.key);
			const remaining = files.filter((other) => other !== placed);
			if (remaining.length) this.days.set(placed.key, remaining);
			else {
				this.days.delete(placed.key);
				this.sortedDirty = true;
			}
		}
	}

	private announce(keys: Set<string> | null): void {
		if (keys && !keys.size) return;
		if (keys) this.version++;
		const list = keys ? Array.from(keys) : null;
		for (const listener of this.listeners) listener(list);
	}

	private list(): string[] {
		if (this.sortedDirty) {
			this.sorted = Array.from(this.days.keys()).sort();
			this.sortedDirty = false;
		}
		return this.sorted;
	}
}
