import { TFile, getAllTags } from "obsidian";
import { normalizeFilterTag } from "../filter";
import type JournalViewPlugin from "../main";
import type { Moment } from "../moment";
import { DAY_KEY_FORMAT } from "../noteIndex";
import { propertiesOf } from "./context";
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
	return {
		journal: {
			notes,
			body: async (note) => {
				const file = files.get(note.path);
				return file ? plugin.findCorpus.read(file) : null;
			},
		},
		close: release,
	};
}
