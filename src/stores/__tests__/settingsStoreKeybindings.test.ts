import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/themes", () => ({
	applyTheme: vi.fn(),
	getTheme: vi.fn((name: string) => ({
		name,
		displayName: name,
		ui: {},
		terminal: { background: "#000" },
	})),
}));

import { broadcastSliceOf } from "../../lib/settingsBroadcast";
import { PERSISTED_KEYS, useSettingsStore } from "../settingsStore";

const cmdK = { key: "k", meta: true, shift: false, ctrl: false, alt: false };

beforeEach(() => {
	useSettingsStore.setState({ keybindingOverrides: {} });
});

describe("keybinding Overrides", () => {
	it("persist and cross Window boundaries", () => {
		expect(PERSISTED_KEYS).toContain("keybindingOverrides");
		useSettingsStore.getState().setKeybindingOverride("app:new-tab", cmdK);
		const slice = broadcastSliceOf(
			useSettingsStore.getState() as unknown as Record<string, unknown>,
		);
		expect(slice.keybindingOverrides).toEqual({ "app:new-tab": cmdK });
	});

	it("reset deletes the entry rather than writing the default", () => {
		const s = useSettingsStore.getState();
		s.setKeybindingOverride("app:new-tab", cmdK);
		s.setKeybindingOverride("app:close-tab", null);
		useSettingsStore.getState().resetKeybinding("app:new-tab");
		expect(useSettingsStore.getState().keybindingOverrides).toEqual({
			"app:close-tab": null,
		});
		useSettingsStore.getState().resetAllKeybindings();
		expect(useSettingsStore.getState().keybindingOverrides).toEqual({});
	});

	it("applies a Reassign in one write", () => {
		const seen: unknown[] = [];
		const unsub = useSettingsStore.subscribe((s) =>
			seen.push(s.keybindingOverrides),
		);
		useSettingsStore.getState().setKeybindingOverrides({
			"app:new-tab": cmdK,
			"app:command-palette": null,
		});
		unsub();
		expect(seen).toEqual([
			{ "app:new-tab": cmdK, "app:command-palette": null },
		]);
	});

	it("migrates a v13 snapshot to an empty Override map", () => {
		const migrate = useSettingsStore.persist.getOptions().migrate;
		if (!migrate) throw new Error("expected a migrate function");
		const state = migrate({ theme: "x" }, 13) as {
			keybindingOverrides: unknown;
		};
		expect(state.keybindingOverrides).toEqual({});
		const kept = migrate(
			{ keybindingOverrides: { "app:new-tab": null } },
			13,
		) as {
			keybindingOverrides: unknown;
		};
		expect(kept.keybindingOverrides).toEqual({ "app:new-tab": null });
	});

	it("drops malformed Overrides arriving through a rehydrate", () => {
		const merge = useSettingsStore.persist.getOptions().merge;
		if (!merge) throw new Error("expected a merge function");
		const merged = merge(
			{ keybindingOverrides: { "app:new-tab": cmdK, "app:bad": "Cmd+K" } },
			useSettingsStore.getState(),
		);
		expect(merged.keybindingOverrides).toEqual({ "app:new-tab": cmdK });
	});
});
