import { Plugin, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { DailyNoteResolver } from "./dailyNotes";
import { DailyNoteIndex } from "./noteIndex";
import {
	DEFAULT_SETTINGS,
	JournalViewSettingTab,
	JournalViewSettings,
	clampSaveDelay,
} from "./settings";
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

		this.addRibbonIcon("notebook", "Open journal", () => void this.activateView());

		this.addCommand({
			id: "open",
			name: "Open",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "open-new-tab",
			name: "Open in a new tab",
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

	onunload(): void {
		// Views clean themselves up in onClose; make sure nothing typed in the
		// last moment is lost when the plugin is disabled or reloaded.
		const flushes: Promise<void>[] = [];
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_JOURNAL)) {
			const view = leaf.view;
			if (view instanceof JournalView) flushes.push(view.flushAll());
		}
		void Promise.all(flushes).catch((error: unknown) => {
			console.error("Journal View: could not flush all pending edits during unload", error);
		});
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
		const saved: unknown = await this.loadData();
		if (!isRecord(saved)) {
			this.settings = { ...DEFAULT_SETTINGS };
			return;
		}
		this.settings = {
			dateFormat: stringSetting(saved.dateFormat, DEFAULT_SETTINGS.dateFormat),
			folder: stringSetting(saved.folder, DEFAULT_SETTINGS.folder),
			templatePath: stringSetting(saved.templatePath, DEFAULT_SETTINGS.templatePath),
			headerFormat: stringSetting(saved.headerFormat, DEFAULT_SETTINGS.headerFormat),
			saveDelay: saveDelaySetting(saved.saveDelay),
			richEditor: booleanSetting(saved.richEditor, DEFAULT_SETTINGS.richEditor),
			focusTodayOnOpen: booleanSetting(saved.focusTodayOnOpen, DEFAULT_SETTINGS.focusTodayOnOpen),
			hideEmptyDays: booleanSetting(saved.hideEmptyDays, DEFAULT_SETTINGS.hideEmptyDays),
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.notifyViews();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringSetting(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function saveDelaySetting(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SETTINGS.saveDelay;
	return clampSaveDelay(value);
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}
