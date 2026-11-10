import { TFile, getAllTags } from "obsidian";
import { normalizeFilterTag } from "../filter";
import type JournalViewPlugin from "../main";
import type { Moment } from "../moment";
import { DAY_KEY_FORMAT } from "../noteIndex";
import { propertiesOf, propertyLine } from "./context";
import type { IndexableNote } from "./semantic";
import { sharedAcross } from "./tools";
import type { JournalNote, JournalSource } from "./tools";

/**
 * The vault's journal as a reflection reads it: every note the journal's
 * filters let through, up to `today`, oldest first. Notes are judged one by
 * one, as the journal judges them within a day, so a rule such as excluding
 * `#private` keeps those notes from the model.
 *
 * Note texts come through `FindCorpus`, exactly as an editor holds them, and
 * are kept there while the run reads, shared with the journal's own find;
 * call `close` once the run is over. Links are written as from `sourcePath`,
 * the reflection's note.
 */
export function openJournal(
	plugin: JournalViewPlugin,
	today: Moment,
	sourcePath: string,
): { journal: JournalSource; close: () => void } {
	const { app } = plugin;
	plugin.filteredIndex.ensureCurrent();
	const last = today.format(DAY_KEY_FORMAT);
	const files = new Map<string, TFile>();
	const notes: JournalNote[] = [];
	for (const key of plugin.index.keys()) {
		if (key > last) break;
		for (const path of plugin.index.pathsFor(key)) {
			const file = app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile) || !plugin.filteredIndex.matchesPath(path)) continue;
			const cache = app.metadataCache.getFileCache(file);
			files.set(path, file);
			notes.push({
				key,
				path,
				link: `[[${app.metadataCache.fileToLinktext(file, sourcePath)}]]`,
				name: file.basename,
				properties: propertiesOf(cache?.frontmatter),
				tags: [...new Set((getAllTags(cache ?? {}) ?? []).map(normalizeFilterTag))],
			});
		}
	}
	const release = plugin.findCorpus.retain();
	const journal: JournalSource = {
		notes,
		body: async (note) => {
			const file = files.get(note.path);
			return file ? plugin.findCorpus.read(file) : null;
		},
	};
	// By meaning too, once the reader has turned that on: the index is brought up to date for these notes first.
	if (plugin.settings.reflectionSemantic) {
		journal.nearest = (texts, signal, onStatus) =>
			plugin.reflectionIndex.nearest(indexableNotes(plugin, notes, journal.body), texts, signal, onStatus);
	}
	return { journal, close: release };
}

/**
 * A journal's notes as the index keeps them: when each last changed, what
 * is said above its text, and how to read it. A note is embedded with its
 * properties, which say what its text may not: its mood, its tags.
 */
export function indexableNotes(
	plugin: JournalViewPlugin,
	notes: readonly JournalNote[],
	body: (note: JournalNote) => Promise<string | null>,
): IndexableNote[] {
	const shared = sharedAcross(notes);
	const indexable: IndexableNote[] = [];
	for (const note of notes) {
		const file = plugin.app.vault.getAbstractFileByPath(note.path);
		if (!(file instanceof TFile)) continue;
		indexable.push({
			path: note.path,
			mtime: file.stat.mtime,
			size: file.stat.size,
			heading: propertyLine(note, shared),
			body: () => body(note),
		});
	}
	return indexable;
}
