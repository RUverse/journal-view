import { App, TFile, TFolder, normalizePath } from "obsidian";
import { createMoment } from "./moment";
import type { Moment } from "./moment";
import type { JournalViewSettings } from "./settings";

export interface ResolvedDailyConfig {
	/** The date format file names are written with. */
	format: string;
	folder: string;
	template: string;
	/** A note's name may go on after the date, and a day can be given further notes. */
	multipleNotes: boolean;
}

/** Daily-note settings as the vault itself has them, before Journal View's own. */
export type VaultDailyConfig = Omit<ResolvedDailyConfig, "multipleNotes">;

const FALLBACK_FORMAT = "YYYY-MM-DD";
/**
 * Journal View 1.4.0 took in notes named with more after the date when the
 * format ended in this. The setting has moved to a toggle, and a format
 * still ending in it - one the vault's own settings hold - is read without it.
 */
const LEGACY_WILDCARD = "*";
/** How a note added to a day records the time it was added, after the date. */
const ADDED_NOTE_TIME = "HH-mm";

function trimSlashes(value: string): string {
	return value.replace(/^\/+|\/+$/g, "").trim();
}

/**
 * True when file names written with `format` record a time of day as well as
 * the date, e.g. `YYYY-MM-DD HHmm`. Such a vault can hold several notes for one
 * day. Bracketed text is literal, and the long locale formats include a time.
 */
export function formatRecordsTime(format: string): boolean {
	const tokens = format.replace(/\[[^\]]*\]/g, "");
	return /[HhkmsSAaXx]|LT|LLL|lll/.test(tokens);
}

/**
 * Resolves where a given day's note lives, and creates it on demand.
 *
 * Precedence: Journal View's own overrides -> Periodic Notes (if it handles daily
 * notes) -> the core Daily notes plugin -> plain `YYYY-MM-DD` in the vault root.
 */
export class DailyNoteResolver {
	constructor(
		private app: App,
		private getSettings: () => JournalViewSettings,
	) {}

	config(): ResolvedDailyConfig {
		const settings = this.getSettings();
		const vault = this.vaultConfig();
		let format = (settings.dateFormat || vault.format || FALLBACK_FORMAT).trim();
		if (format.endsWith(LEGACY_WILDCARD)) format = format.slice(0, -LEGACY_WILDCARD.length).trimEnd();
		return {
			format: format || FALLBACK_FORMAT,
			folder: trimSlashes(settings.folder || vault.folder || ""),
			template: (settings.templatePath || vault.template || "").trim(),
			multipleNotes: settings.multipleNotesPerDay,
		};
	}

	/**
	 * What Journal View's fields fall back to when left empty: the vault's
	 * daily-note settings, or `YYYY-MM-DD` in the vault root.
	 */
	inherited(): VaultDailyConfig {
		const vault = this.vaultConfig();
		return { format: vault.format || FALLBACK_FORMAT, folder: trimSlashes(vault.folder), template: vault.template };
	}

	private vaultConfig(): VaultDailyConfig {
		const empty: VaultDailyConfig = { format: "", folder: "", template: "" };
		try {
			const periodic = this.app.plugins?.getPlugin("periodic-notes") as
				| { settings?: { daily?: { enabled?: boolean; format?: string; folder?: string; template?: string } } }
				| null
				| undefined;
			const daily = periodic?.settings?.daily;
			if (daily?.enabled) {
				return {
					format: (daily.format ?? "").trim(),
					folder: (daily.folder ?? "").trim(),
					template: (daily.template ?? "").trim(),
				};
			}
		} catch (error) {
			console.warn("Journal View: could not read Periodic Notes settings", error);
		}

		try {
			const options = this.app.internalPlugins?.getPluginById("daily-notes")?.instance?.options;
			if (options) {
				return {
					format: (options.format ?? "").trim(),
					folder: (options.folder ?? "").trim(),
					template: (options.template ?? "").trim(),
				};
			}
		} catch (error) {
			console.warn("Journal View: could not read Daily notes settings", error);
		}

		return empty;
	}

	/** True when the configured file names record a time of day (see `formatRecordsTime`). */
	recordsTime(): boolean {
		return formatRecordsTime(this.config().format);
	}

	/**
	 * The moment a note created now for `date` is named after: the date itself,
	 * or - when file names record a time - the date at the current time of day,
	 * so each new note for that day gets a file of its own.
	 */
	creationMoment(date: Moment): Moment {
		return this.recordsTime() ? this.atCurrentTime(date) : date.clone().startOf("day");
	}

	/** `date` at the current time of day. */
	atCurrentTime(date: Moment): Moment {
		const now = createMoment();
		return date
			.clone()
			.startOf("day")
			.set({ hour: now.hour(), minute: now.minute(), second: now.second(), millisecond: 0 });
	}

	/** File name (without extension) a note for `date` would have. */
	basename(date: Moment): string {
		const { format } = this.config();
		const name = date.format(format);
		// A broken format string can produce an empty or invalid name.
		return name && !name.includes("\n") ? name : date.format(FALLBACK_FORMAT);
	}

	pathFor(date: Moment): string {
		return this.pathNamed(this.basename(date));
	}

	/**
	 * Where a note added to a day at `at` goes: named after the date and the
	 * time, `2026-10-02 14-30`, or after the format alone when it records a
	 * time of its own. Pass it to `create` as a numbered note.
	 */
	addedNotePath(at: Moment): string {
		if (this.recordsTime()) return this.pathFor(at);
		return this.pathNamed(`${this.basename(at)} ${at.format(ADDED_NOTE_TIME)}`);
	}

	private pathNamed(name: string): string {
		const { folder } = this.config();
		return normalizePath(`${folder ? `${folder}/` : ""}${name}.md`);
	}

	/**
	 * The first name for a new note for `date`, starting at `preferred`, that no
	 * file has taken. A format that records a time moves on a minute at a time
	 * within the day, and a `numbered` note - one added to a day that already
	 * has its note - goes on to `preferred-1`, `preferred-2` and so on. Otherwise
	 * a plain format names a single note per day, so its one name is returned
	 * even when taken; null means every name there was to try is taken.
	 */
	freePath(date: Moment, preferred = this.pathFor(date), numbered = false): string | null {
		const taken = (path: string) => this.app.vault.getAbstractFileByPath(path) !== null;
		if (!taken(preferred)) return preferred;
		const recordsTime = this.recordsTime();
		if (recordsTime) {
			const day = date.clone().startOf("day");
			const at = date.clone();
			while (at.add(1, "minutes").isSame(day, "day")) {
				const path = this.pathFor(at);
				if (!taken(path)) return path;
			}
		}
		if (numbered) {
			const base = preferred.slice(0, -".md".length);
			for (let number = 1; number < 1000; number++) {
				const path = `${base}-${number}.md`;
				if (!taken(path)) return path;
			}
		}
		return numbered || recordsTime ? null : preferred;
	}

	/**
	 * Creates a note for `date` from the configured template, at `preferred` or
	 * the first free name after it (see `freePath`, which `numbered` is passed
	 * on to), so a new note never lands in a file another note already has.
	 * The template's title is the name the note gets. Pass a `creationMoment`
	 * so formats that record a time get the current one. `claim` hears the
	 * chosen path before the file exists.
	 *
	 * Callers that have body text of their own write it over the result, which
	 * keeps the template's frontmatter without duplicating it.
	 */
	async create(
		date: Moment,
		preferred = this.pathFor(date),
		claim?: (path: string) => void,
		numbered = false,
	): Promise<TFile> {
		const template = await this.readTemplate();
		// A name can be taken between choosing it and creating the file - by
		// another view, or a sync client. Choose again when that happens.
		for (let attempt = 0; attempt < 3; attempt++) {
			const path = this.freePath(date, preferred, numbered);
			if (!path) break;
			// A plain format's one note for the day already exists: write to it.
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) return existing;
			claim?.(path);
			await this.ensureFolder(path);
			const body = this.fillTemplate(template, date, path.slice(path.lastIndexOf("/") + 1, -".md".length));
			try {
				return await this.app.vault.create(path, body);
			} catch (error) {
				if (!this.app.vault.getAbstractFileByPath(path)) throw error;
			}
		}
		throw new Error(`No free name for a new note at ${preferred}`);
	}

	private async ensureFolder(filePath: string): Promise<void> {
		const parent = filePath.split("/").slice(0, -1).join("/");
		if (!parent) return;
		if (this.app.vault.getAbstractFileByPath(parent) instanceof TFolder) return;

		const parts = parent.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (this.app.vault.getAbstractFileByPath(current)) continue;
			try {
				await this.app.vault.createFolder(current);
			} catch (error) {
				// Already exists (created concurrently) - keep going.
				if (!this.app.vault.getAbstractFileByPath(current)) throw error;
			}
		}
	}

	/**
	 * The configured template, with its date placeholders filled in for `date`
	 * and its title for a note named `title` - by default, the date's note.
	 * Empty when no template is set, or when the file it names cannot be read -
	 * a day without a template is a working day, so this never rejects.
	 */
	async templateContent(date: Moment, title = this.basename(date)): Promise<string> {
		return this.fillTemplate(await this.readTemplate(), date, title);
	}

	/** The configured template as written, or empty - see `templateContent`. */
	private async readTemplate(): Promise<string> {
		const { template } = this.config();
		if (!template) return "";

		const path = template.endsWith(".md") ? template : `${template}.md`;
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (!(file instanceof TFile)) {
			console.warn(`Journal View: template not found at "${path}"`);
			return "";
		}

		try {
			// The template can be deleted or renamed between the lookup above
			// and the read - by the reader, or by Sync.
			return await this.app.vault.cachedRead(file);
		} catch (error) {
			console.warn(`Journal View: could not read the template at "${path}"`, error);
			return "";
		}
	}

	/** `template` with its date placeholders filled in for `date`, and its title for a note named `title`. */
	private fillTemplate(template: string, date: Moment, title: string): string {
		return template
			.replace(/{{\s*(date|time)\s*:\s*([^}]+)}}/gi, (_match, _kind: string, format: string) =>
				date.format(format.trim()),
			)
			.replace(/{{\s*date\s*}}/gi, date.format(this.config().format))
			.replace(/{{\s*time\s*}}/gi, date.format("HH:mm"))
			.replace(/{{\s*title\s*}}/gi, title);
	}
}
