import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { Moment } from "moment";
import type { JournalViewSettings } from "./settings";

export interface ResolvedDailyConfig {
	format: string;
	folder: string;
	template: string;
}

const FALLBACK_FORMAT = "YYYY-MM-DD";

function trimSlashes(value: string): string {
	return value.replace(/^\/+|\/+$/g, "").trim();
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
		return {
			format: settings.dateFormat || vault.format || FALLBACK_FORMAT,
			folder: trimSlashes(settings.folder || vault.folder || ""),
			template: (settings.templatePath || vault.template || "").trim(),
		};
	}

	private vaultConfig(): ResolvedDailyConfig {
		const empty: ResolvedDailyConfig = { format: "", folder: "", template: "" };
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

	fileFor(date: Moment): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(this.pathFor(date));
		return file instanceof TFile ? file : null;
	}

	/**
	 * Creates the note for `date` from the configured template. Callers that
	 * have body text of their own write it over the result, which keeps the
	 * template's frontmatter without duplicating it.
	 */
	async create(date: Moment): Promise<TFile> {
		const path = this.pathFor(date);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;

		await this.ensureFolder(path);
		const body = await this.templateContent(date);
		try {
			return await this.app.vault.create(path, body);
		} catch (error) {
			// Someone (another view, a sync client) may have created it in the
			// meantime - reuse it rather than failing the keystroke.
			const raced = this.app.vault.getAbstractFileByPath(path);
			if (raced instanceof TFile) return raced;
			throw error;
		}
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
