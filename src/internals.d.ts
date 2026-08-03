import "obsidian";

/**
 * Small ambient declarations for the parts of Obsidian's internal API that
 * Journal View touches. Everything here is optional and guarded at runtime, so a
 * future API change degrades gracefully instead of breaking the view.
 */
declare module "obsidian" {
	interface App {
		internalPlugins?: {
			getPluginById(id: string): { instance?: { options?: Record<string, string> } } | null;
		};
		plugins?: {
			getPlugin(id: string): unknown;
			plugins: Record<string, unknown>;
		};
		embedRegistry?: {
			embedByExtension: Record<string, (ctx: unknown, file: unknown, subpath: string) => unknown>;
		};
	}
}
