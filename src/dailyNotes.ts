import { App, TFile, TFolder, normalizePath } from "obsidian";
import { createMoment } from "./moment";
import type { Moment } from "./moment";
import type { JournalViewSettings } from "./settings";

export interface ResolvedDailyConfig {
	/** The date format file names are written with, without any trailing `*`. */
	format: string;
	folder: string;
	template: string;
	/** The format ended in `*`: a note's name may go on after the date. */
	wildcard: boolean;
}

type VaultDailyConfig = Omit<ResolvedDailyConfig, "wildcard">;

const FALLBACK_FORMAT = "YYYY-MM-DD";
/** Ends a date format to take in notes named with more after the date. */
const WILDCARD = "*";

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
		const format = (settings.dateFormat || vault.format || FALLBACK_FORMAT).trim();
		const wildcard = format.endsWith(WILDCARD);
		return {
			format: (wildcard ? format.slice(0, -WILDCARD.length).trimEnd() : format) || FALLBACK_FORMAT,
			folder: trimSlashes(settings.folder || vault.folder || ""),
			template: (settings.templatePath || vault.template || "").trim(),
			wildcard,
		};
	}

	/** The date format as configured, `*` included. */
	displayFormat(config = this.config()): string {
		return config.wildcard ? `${config.format}${WILDCARD}` : config.format;
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
		const day = date.clone().startOf("day");
		if (!this.recordsTime()) return day;
		const now = createMoment();
		return day.set({ hour: now.hour(), minute: now.minute(), second: now.second(), millisecond: 0 });
	}

	/** File name (without extension) a note for `date` would have. */
	basename(date: Moment): string {
		const { format } = this.config();
		const name = date.format(format);
		// A broken format string can produce an empty or invalid name.
		return name && !name.includes("\n") ? name : date.format(FALLBACK_FORMAT);
	}

	pathFor(date: Moment): string {
		const { folder } = this.config();
		const name = this.basename(date);
		return normalizePath(`${folder ? `${folder}/` : ""}${name}.md`);
	}

	/**
	 * The first name for a new note for `date`, starting at `preferred`, that no
	 * file has taken. A format that records a time moves on a minute at a time
	 * within the day, and one that ends in `*` numbers the note after the date.
	 * A plain format names a single note per day, so its one name is returned
	 * even when taken; null means every name the format could give is taken.
	 */
	freePath(date: Moment, preferred = this.pathFor(date)): string | null {
		const taken = (path: string) => this.app.vault.getAbstractFileByPath(path) !== null;
		if (!taken(preferred)) return preferred;
		const config = this.config();
		if (formatRecordsTime(config.format)) {
			const day = date.clone().startOf("day");
			const at = date.clone();
			while (at.add(1, "minutes").isSame(day, "day")) {
				const path = this.pathFor(at);
				if (!taken(path)) return path;
			}
		}
		if (config.wildcard) {
			const base = preferred.slice(0, -".md".length);
			for (let number = 2; number < 1000; number++) {
				const path = `${base} ${number}.md`;
				if (!taken(path)) return path;
			}
		}
		return config.wildcard || formatRecordsTime(config.format) ? null : preferred;
	}

	/**
	 * Creates a note for `date` from the configured template, at `preferred` or
	 * the first free name after it (see `freePath`), so a new note never lands
	 * in a file another note already has. Pass a `creationMoment` so formats
	 * that record a time get the current one. `claim` hears the chosen path
	 * before the file exists.
	 *
	 * Callers that have body text of their own write it over the result, which
	 * keeps the template's frontmatter without duplicating it.
	 */
	async create(date: Moment, preferred = this.pathFor(date), claim?: (path: string) => void): Promise<TFile> {
		const body = await this.templateContent(date);
		// A name can be taken between choosing it and creating the file - by
		// another view, or a sync client. Choose again when that happens.
		for (let attempt = 0; attempt < 3; attempt++) {
			const path = this.freePath(date, preferred);
			if (!path) break;
			// A plain format's one note for the day already exists: write to it.
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) return existing;
			claim?.(path);
			await this.ensureFolder(path);
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
	 * The configured template, with its date placeholders filled in for `date`.
	 * Empty when no template is set, or when the file it names cannot be read -
	 * a day without a template is a working day, so this never rejects.
	 */
	async templateContent(date: Moment): Promise<string> {
		const { template } = this.config();
		if (!template) return "";

		const path = template.endsWith(".md") ? template : `${template}.md`;
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (!(file instanceof TFile)) {
			console.warn(`Journal View: template not found at "${path}"`);
			return "";
		}

		let raw: string;
		try {
			// The template can be deleted or renamed between the lookup above
			// and the read - by the reader, or by Sync.
			raw = await this.app.vault.cachedRead(file);
		} catch (error) {
			console.warn(`Journal View: could not read the template at "${path}"`, error);
			return "";
		}

		return raw
			.replace(/{{\s*(date|time)\s*:\s*([^}]+)}}/gi, (_match, _kind: string, format: string) =>
				date.format(format.trim()),
			)
			.replace(/{{\s*date\s*}}/gi, date.format(this.config().format))
			.replace(/{{\s*time\s*}}/gi, date.format("HH:mm"))
			.replace(/{{\s*title\s*}}/gi, this.basename(date));
	}
}
