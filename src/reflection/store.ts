import { Component, Notice, TFile, normalizePath } from "obsidian";
import type { App, TAbstractFile } from "obsidian";
import type JournalViewPlugin from "../main";
import { createMoment } from "../moment";
import type { Moment } from "../moment";

/** The property that marks a note as a reflection, and its value. */
export const REFLECTION_PROPERTY = "journal-view";
export const REFLECTION_VALUE = "reflection";

/** Reflection notes start with the day they were made: `2026-10-19 What I learned.md`. */
const NAME_DATE = /^(\d{4}-\d{2}-\d{2})\b/;
/** How `created` is written: local time to the minute, as Obsidian writes a date & time property. */
const CREATED_FORMAT = "YYYY-MM-DDTHH:mm";
/** Characters a file name cannot hold, replaced when a title becomes one. */
const UNSAFE_NAME = /[\\/:*?"<>|#^[\]]/g;

/** One reflection note, as the journal lists it under the day it was made. */
export interface StoredReflection {
	file: TFile;
	/** The day it belongs to, `YYYY-MM-DD`. */
	key: string;
	/** When it was made, which orders a day's reflections. */
	time: number;
	/** What it was asked, for its card: the preset's name or the custom prompt. */
	title: string;
	model: string | null;
	/** The range it read, as `YYYY-MM-DD` keys. */
	from: string | null;
	to: string | null;
	/** Links to the notes it read, as written in the note. */
	sources: string[];
}

/** What a new reflection note records about how it was made. */
export interface ReflectionRecord {
	created: Moment;
	title: string;
	preset: string | null;
	prompt: string;
	model: string;
	from: string;
	to: string;
	/** Links to the notes it read, such as `[[2026-10-05]]`. */
	sources: string[];
}

type Listener = (keys: string[] | null) => void;

/**
 * Indexes the notes in the Reflections folder by the day they were made, and
 * writes and deletes them. A note's day comes from its `created` property,
 * or from the date its name starts with while Obsidian has not read the
 * property yet. The folder is never the daily-note folder, and a note the
 * daily-note index claims is never taken for a reflection.
 */
export class ReflectionStore extends Component {
	private byKey = new Map<string, StoredReflection[]>();
	private byPath = new Map<string, StoredReflection>();
	private listeners = new Set<Listener>();
	/** The folders the index was built for, to notice when either moves. */
	private signature = "";

	constructor(
		private app: App,
		private plugin: JournalViewPlugin,
	) {
		super();
	}

	onload(): void {
		this.app.workspace.onLayoutReady(() => this.rebuild());
		this.registerEvent(this.app.vault.on("create", (file) => this.update(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.remove(file.path)));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.remove(oldPath);
				this.update(file);
			}),
		);
		this.registerEvent(this.app.metadataCache.on("changed", (file) => this.update(file)));
	}

	/** The folder reflections live in, or null while it would be the daily-note folder. */
	folder(): string | null {
		const folder = this.plugin.settings.reflectionFolder;
		const daily = this.plugin.daily.config().folder;
		return folder === daily ? null : folder;
	}

	/** The reflections made on a day, oldest first. */
	reflectionsFor(key: string): readonly StoredReflection[] {
		return this.byKey.get(key) ?? [];
	}

	/** Listens for reflections appearing, changing or going: the days touched, or null for all. */
	onChanged(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Indexes the folder again if it, or the daily-note folder, moved since the last time. */
	ensureCurrent(): void {
		if (this.signatureNow() !== this.signature) this.rebuild();
	}

	private signatureNow(): string {
		return JSON.stringify([this.plugin.settings.reflectionFolder, this.plugin.daily.config().folder]);
	}

	/** Indexes the folder again from scratch, after the folder or the daily-note settings changed. */
	rebuild(): void {
		this.signature = this.signatureNow();
		this.byKey.clear();
		this.byPath.clear();
		const folder = this.folder();
		if (folder !== null) {
			for (const file of this.app.vault.getMarkdownFiles()) {
				const reflection = this.read(file, folder);
				if (reflection) this.add(reflection);
			}
		}
		this.notify(null);
	}

	private update(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		const folder = this.folder();
		const previous = this.byPath.get(file.path);
		const next = folder === null ? null : this.read(file, folder);
		if (!previous && !next) return;
		if (previous) this.drop(previous);
		if (next) this.add(next);
		this.notify([...new Set([previous?.key, next?.key].filter((key): key is string => !!key))]);
	}

	private remove(path: string): void {
		const previous = this.byPath.get(path);
		if (!previous) return;
		this.drop(previous);
		this.notify([previous.key]);
	}

	private read(file: TFile, folder: string): StoredReflection | null {
		if (file.extension !== "md" || !file.path.startsWith(folder ? `${folder}/` : "")) return null;
		if (this.plugin.index.keyForPath(file.path) !== null) return null;
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const named = NAME_DATE.exec(file.basename)?.[1];
		// A note just written has no cached properties yet; its name stands in.
		if (frontmatter && frontmatter[REFLECTION_PROPERTY] !== REFLECTION_VALUE) return null;
		if (!frontmatter && !named) return null;
		const created = createMoment(String(frontmatter?.created ?? named ?? ""), [CREATED_FORMAT, "YYYY-MM-DD"], true);
		if (!created.isValid()) return null;
		const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
		const sources: unknown = frontmatter?.sources;
		return {
			file,
			key: created.format("YYYY-MM-DD"),
			time: created.valueOf(),
			title: text(frontmatter?.title) ?? file.basename.replace(NAME_DATE, "").trim(),
			model: text(frontmatter?.model),
			from: text(frontmatter?.from),
			to: text(frontmatter?.to),
			sources: Array.isArray(sources) ? sources.filter((source): source is string => typeof source === "string") : [],
		};
	}

	private add(reflection: StoredReflection): void {
		this.byPath.set(reflection.file.path, reflection);
		const list = this.byKey.get(reflection.key) ?? [];
		list.push(reflection);
		list.sort((left, right) => left.time - right.time || left.file.path.localeCompare(right.file.path));
		this.byKey.set(reflection.key, list);
	}

	private drop(reflection: StoredReflection): void {
		this.byPath.delete(reflection.file.path);
		const list = this.byKey.get(reflection.key)?.filter((other) => other.file.path !== reflection.file.path);
		if (list?.length) this.byKey.set(reflection.key, list);
		else this.byKey.delete(reflection.key);
	}

	private notify(keys: string[] | null): void {
		for (const listener of this.listeners) listener(keys);
	}

	/* --------------------------------------------------------------- writes */

	/**
	 * Writes a new reflection note, named after its day and title, with a
	 * number after the title when the day already has one by that name.
	 */
	async create(record: ReflectionRecord, body: string): Promise<TFile> {
		const folder = this.folder();
		if (folder === null) throw new Error("The Reflections folder cannot be the daily-note folder");
		if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
			try {
				await this.app.vault.createFolder(folder);
			} catch {
				// Created meanwhile by another write; the note goes in either way.
			}
		}
		const base = `${record.created.format("YYYY-MM-DD")} ${fileTitle(record.title)}`;
		const text = `${frontmatterFor(record)}\n${body.trim()}\n`;
		for (let attempt = 0; attempt < 100; attempt++) {
			const name = attempt === 0 ? base : `${base} ${attempt}`;
			const path = normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
			if (this.app.vault.getAbstractFileByPath(path)) continue;
			try {
				return await this.app.vault.create(path, text);
			} catch (error) {
				// Taken between the check and the write: try the next number.
				if (this.app.vault.getAbstractFileByPath(path)) continue;
				throw error;
			}
		}
		throw new Error(`Could not name a reflection after ${base}`);
	}

	/** Deletes a reflection the way a note is deleted: asking first, if Obsidian is set to, into the trash. */
	async delete(file: TFile): Promise<void> {
		try {
			const { fileManager } = this.app;
			if (!(await fileManager.promptForDeletion(file))) return;
			await fileManager.trashFile(file);
		} catch (error) {
			console.error(`Journal View: could not delete ${file.path}`, error);
			new Notice(`Journal View: could not delete ${file.path}`);
		}
	}
}

/** A title fit for a file name: no unsafe characters, and short. */
function fileTitle(title: string): string {
	const safe = title.replace(UNSAFE_NAME, " ").replace(/\s+/g, " ").trim();
	const words = safe.split(" ").slice(0, 8).join(" ");
	return (words.length > 60 ? words.slice(0, 60).trimEnd() : words) || "Reflection";
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function frontmatterFor(record: ReflectionRecord): string {
	const lines = [
		"---",
		`${REFLECTION_PROPERTY}: ${REFLECTION_VALUE}`,
		`created: ${record.created.format(CREATED_FORMAT)}`,
		`title: ${yamlString(record.title)}`,
		...(record.preset ? [`preset: ${record.preset}`] : []),
		`prompt: ${yamlString(record.prompt)}`,
		`model: ${yamlString(record.model)}`,
		`from: ${record.from}`,
		`to: ${record.to}`,
		"sources:",
		...record.sources.map((source) => `  - ${yamlString(source)}`),
		"---",
	];
	return lines.join("\n");
}
