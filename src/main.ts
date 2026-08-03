import { Plugin, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { DailyNoteResolver } from "./dailyNotes";
import { DailyNoteIndex } from "./noteIndex";
import { DEFAULT_SETTINGS, JournalViewSettingTab, JournalViewSettings } from "./settings";
import { JournalView, VIEW_TYPE_JOURNAL } from "./view";

export default class JournalViewPlugin extends Plugin {
	settings: JournalViewSettings = { ...DEFAULT_SETTINGS };
	daily!: DailyNoteResolver;
	index!: DailyNoteIndex;

	private notifyViews = debounce(
		() => {
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_JOURNAL)) {
				const view = leaf.view;
				if (view instanceof JournalView) void view.onSettingsChanged();
			}
		},
		400,
		true,
	);

	async onload(): Promise<void> {
		await this.loadSettings();
		this.daily = new DailyNoteResolver(this.app, () => this.settings);
		this.index = new DailyNoteIndex(this.app, this.daily);

		// The index has to be registered before any view, so it is already up to
		// date by the time a view reacts to the same vault event.
		this.app.workspace.onLayoutReady(() => this.index.rebuild());
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFile) this.index.handleCreate(file);
			}),
		);
		this.registerEvent(this.app.vault.on("delete", (file) => this.index.handleDelete(file.path)));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.index.handleDelete(oldPath);
				if (file instanceof TFile) this.index.handleCreate(file);
			}),
		);

		this.registerView(VIEW_TYPE_JOURNAL, (leaf) => new JournalView(leaf, this));

		this.addRibbonIcon("calendar-days", "Open journal", () => void this.activateView());

		this.addCommand({
			id: "open-journal-view",
			name: "Open journal view",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "open-journal-view-new-tab",
			name: "Open journal view in a new tab",
			callback: () => void this.activateView(true),
		});

		this.addCommand({
			id: "go-to-today",
			name: "Go to today",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(JournalView);
				if (!view) return false;
				if (!checking) view.goToToday(true);
				return true;
			},
		});

		this.addSettingTab(new JournalViewSettingTab(this.app, this));
	}

	async onunload(): Promise<void> {
		// Views clean themselves up in onClose; make sure nothing typed in the
		// last moment is lost when the plugin is disabled or reloaded.
		await Promise.all(
			this.app.workspace.getLeavesOfType(VIEW_TYPE_JOURNAL).map((leaf) => {
				const view = leaf.view;
				return view instanceof JournalView ? view.flushAll() : Promise.resolve();
			}),
		);
	}

	async activateView(forceNewTab = false): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_JOURNAL);

		let leaf: WorkspaceLeaf;
		if (existing.length > 0 && !forceNewTab) {
			leaf = existing[0];
		} else {
			leaf = workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE_JOURNAL, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.notifyViews();
	}
}
