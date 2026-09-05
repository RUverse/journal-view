import type { App, Editor, EditorPosition, TFile } from "obsidian";
import type { JournalEditor } from "./editor";

type SortingEditor = Pick<Editor, "getCursor" | "getValue" | "setValue" | "setSelection">;

interface CompletedTasksPlugin {
	settings: { intervalSeconds: number; reorderOnTabChange: boolean };
	reorderView(view: { file: TFile; editor: SortingEditor }): void;
}

/** Read the enabled plugin each time so disabling it or changing settings takes effect. */
export function completedTasksPlugin(app: App): CompletedTasksPlugin | null {
	const plugin = app.plugins?.getPlugin("completed-tasks") as Partial<CompletedTasksPlugin> | null | undefined;
	return plugin?.settings && typeof plugin.reorderView === "function" ? plugin as CompletedTasksPlugin : null;
}

/** Give the existing sorter this day's editor without changing the other plugin. */
export function reorderCompletedTasks(app: App, file: TFile, editor: JournalEditor): boolean {
	const plugin = completedTasksPlugin(app);
	if (!plugin) return false;
	const before = editor.getValue();
	let value = before;
	const initialCursor = editor.getSelectionRange();
	if (!initialCursor) return false;
	let cursor = initialCursor;
	const position = (offset: number): EditorPosition => {
		const lines = value.slice(0, offset).split("\n");
		return { line: lines.length - 1, ch: lines[lines.length - 1].length };
	};
	const offset = (pos: EditorPosition): number => {
		const lines = value.split("\n");
		const line = Math.max(0, Math.min(pos.line, lines.length - 1));
		return lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0) + Math.min(pos.ch, lines[line].length);
	};
	const adapter: SortingEditor = {
		getValue: () => value,
		getCursor: (which = "head") => position(
			which === "anchor" ? cursor.anchor : which === "from" ? Math.min(cursor.anchor, cursor.head)
				: which === "to" ? Math.max(cursor.anchor, cursor.head) : cursor.head,
		),
		setValue: (next) => { value = next; },
		setSelection: (anchor, head = anchor) => { cursor = { anchor: offset(anchor), head: offset(head) }; },
	};
	try {
		// The plugin checks the file's frontmatter itself, including completedTasks: false.
		// Work on a snapshot first so a failing integration cannot leave a partial edit.
		plugin.reorderView({ file, editor: adapter });
		if (value !== before) {
			editor.setValue(value, true);
			editor.setSelectionRange(cursor);
		}
		return true;
	} catch (error) {
		console.warn("Journal View: could not reorder completed tasks", error);
		return false;
	}
}
