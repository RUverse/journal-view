import { setIcon } from "obsidian";
import type JournalViewPlugin from "../main";

/**
 * Today's handle: a faint pill under the day's card that grows into a
 * Reflect button when hovered or focused, and opens the Reflect window.
 */
export class ReflectButton {
	readonly el: HTMLElement;

	constructor(plugin: JournalViewPlugin) {
		this.el = createDiv({ cls: "journal-reflect" });
		const button = this.el.createEl("button", {
			cls: "journal-reflect-button",
			attr: { "aria-label": "Reflect on your notes", "aria-haspopup": "dialog" },
		});
		setIcon(button.createSpan({ cls: "journal-reflect-icon" }), "sparkles");
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
