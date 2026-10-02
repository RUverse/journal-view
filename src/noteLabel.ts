/** What names a note beyond its date, shown in the day's header or above the note. */
export interface NoteLabel {
	/** Fixed text: the time the file name records, or the file's name when nothing else names it. */
	text: string | null;
	/** The text after the date, which the reader can rename the note by. */
	title: string | null;
}

/** Characters a file name cannot hold, or that would break a link to it. */
export const INVALID_TITLE_CHARACTERS = /[\\/:*?"<>|#^[\]]/;

/**
 * Writes `label` into `el`. Given `onRetitle`, a click on the title edits it
 * in place: Enter or leaving the field renames the note, Escape keeps the
 * name. A label being edited is left alone, so a redraw does not take the
 * field out from under the reader.
 */
export function renderNoteLabel(el: HTMLElement, label: NoteLabel, onRetitle?: (title: string) => void): void {
	if (el.querySelector(".journal-note-title-input")) return;
	el.empty();
	if (label.text) el.createSpan({ text: label.text });
	if (label.text && label.title) el.appendText(" · ");
	const current = label.title;
	if (!current) return;
	const title = el.createSpan({ cls: "journal-note-title", text: current });
	if (!onRetitle) return;
	title.addClass("is-editable");
	title.addEventListener("click", (event) => {
		event.stopPropagation();
		editTitle(title, current, onRetitle);
	});
}

function editTitle(title: HTMLElement, current: string, onRetitle: (title: string) => void): void {
	const input = createEl("input", {
		cls: "journal-note-title-input",
		type: "text",
		value: current,
		attr: { "aria-label": "Note title", spellcheck: "false" },
	});
	let done = false;
	const finish = (save: boolean) => {
		if (done) return;
		done = true;
		const value = input.value.trim();
		input.replaceWith(title);
		if (save && value && value !== current) onRetitle(value);
	};
	input.addEventListener("keydown", (event) => {
		if (event.isComposing) return;
		if (event.key === "Enter") {
			event.preventDefault();
			finish(true);
		} else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			finish(false);
		}
	});
	input.addEventListener("blur", () => finish(true));
	// The entry treats clicks as a way into its editor.
	input.addEventListener("click", (event) => event.stopPropagation());
	title.replaceWith(input);
	input.focus();
	input.select();
}
