import { describe, expect, it } from "vitest";
import { COMMAND_SCOPE, commandScope } from "../commandScope";

const raw = import.meta.glob<string>(
	["/src/lib/ipc.ts", "/src-tauri/src/lib.rs"],
	{ query: "?raw", import: "default", eager: true },
);

function ipcCommands(): string[] {
	const text = raw["/src/lib/ipc.ts"];
	const re = /\binvoke\b(?:<(?:[^<>]|<[^<>]*>)*>)?\(\s*["']([a-z0-9_:|]+)["']/g;
	return [...new Set([...text.matchAll(re)].map((m) => m[1]))];
}

function rustHandlers(): string[] {
	const text = raw["/src-tauri/src/lib.rs"];
	const start = text.indexOf("generate_handler![");
	const body = text.slice(start, text.indexOf("]", start));
	return [...body.matchAll(/([a-z_]+::)*([a-z0-9_]+),/g)].map((m) => m[2]);
}

describe("command scope", () => {
	it("finds the commands it checks", () => {
		expect(ipcCommands().length).toBeGreaterThan(100);
		expect(rustHandlers().length).toBeGreaterThan(100);
	});

	it("labels every command ipc.ts invokes", () => {
		expect(ipcCommands().filter((c) => !COMMAND_SCOPE.has(c))).toEqual([]);
	});

	it("labels every command Rust registers", () => {
		expect(rustHandlers().filter((c) => !COMMAND_SCOPE.has(c))).toEqual([]);
	});

	it("has no label for a command that no longer exists", () => {
		const known = new Set([...ipcCommands(), ...rustHandlers()]);
		expect([...COMMAND_SCOPE.keys()].filter((c) => !known.has(c))).toEqual([]);
	});

	it("keeps window and desktop-app commands on the desktop", () => {
		expect(commandScope("open_settings_window")).toBe("desktop");
		expect(commandScope("updater_check")).toBe("desktop");
		expect(commandScope("pty_spawn")).toBe("host");
		expect(commandScope("fs_read_file")).toBe("host");
	});

	it("treats an unknown command as host", () => {
		expect(commandScope("something_new")).toBe("host");
	});
});
