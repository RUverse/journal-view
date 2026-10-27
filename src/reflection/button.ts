import type JournalViewPlugin from "../main";

/**
 * Today's handle: a faint pill next to the day's card that grows into a
 * Reflect button when hovered or focused, and opens the Reflect window. The
 * pill keeps to the edge facing the card, `above` it when the journal runs
 * newest first, and grows away from it.
 */
export class ReflectButton {
	readonly el: HTMLElement;

	constructor(plugin: JournalViewPlugin, above: boolean) {
		this.el = createDiv({ cls: "journal-reflect" });
		this.el.toggleClass("journal-reflect-above", above);
		const button = this.el.createEl("button", {
			cls: "journal-reflect-button",
			attr: { "aria-label": "Reflect on your notes", "aria-haspopup": "dialog" },
		});
		button.createSpan({ cls: "journal-reflect-label", text: "Reflect" });
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			plugin.openReflectModal();
		});
	}

	destroy(): void {
		this.el.remove();
	}
}
