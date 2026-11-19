import { describe, expect, it } from "vitest";

/**
 * The IPC seam (ADR-0062, docs/plans/remote-hosts.md phase 1): every call to
 * Tauri goes through a handful of modules, so a later phase can route a
 * Workspace's commands to its Host in one place. A direct import anywhere else
 * would bypass that routing (and the demo mocks).
 */
const SEAM_MODULES = new Set([
	"/src/lib/ipc.ts",
	"/src/lib/appWindow.ts",
	"/src/lib/desktop.ts",
	"/src/lib/clipboard.ts",
	"/src/lib/platform.ts",
]);

const sources = import.meta.glob<string>(
	["/src/**/*.{ts,tsx}", "!/src/**/__tests__/**", "!/src/lib/demo/**"],
	{ query: "?raw", import: "default", eager: true },
);

const TAURI_IMPORT = /(from\s+|import\(\s*)["']@tauri-apps\//;

describe("IPC seam", () => {
	it("sees the source tree", () => {
		expect(Object.keys(sources).length).toBeGreaterThan(100);
	});

	it("only the seam modules import @tauri-apps directly", () => {
		const offenders = Object.entries(sources)
			.filter(([path]) => !SEAM_MODULES.has(path))
			.filter(([, text]) => TAURI_IMPORT.test(text))
			.map(([path]) => path);
		expect(offenders).toEqual([]);
	});
});
