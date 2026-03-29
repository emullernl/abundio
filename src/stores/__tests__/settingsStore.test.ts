import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/themes", () => ({
	applyTheme: vi.fn(),
	getTheme: vi.fn((name: string) => ({
		name,
		displayName: name,
		ui: {},
		terminal: { background: "#000" },
	})),
}));

vi.mock("../../lib/terminalManager", () => ({
	setAllTerminalsTheme: vi.fn(),
}));

import { useSettingsStore } from "../settingsStore";
import { applyTheme, getTheme } from "../../lib/themes";
import { setAllTerminalsTheme } from "../../lib/terminalManager";

const mockApplyTheme = vi.mocked(applyTheme);
const mockGetTheme = vi.mocked(getTheme);
const mockSetAllTerminalsTheme = vi.mocked(setAllTerminalsTheme);

beforeEach(() => {
	vi.clearAllMocks();
	useSettingsStore.setState({
		fontFamily: "'JetBrainsMonoNL Nerd Font Mono', monospace",
		fontSize: 14,
		theme: "default",
		sidebarCollapsed: false,
		sidebarSplitRatio: 0.4,
	});
});

describe("settingsStore", () => {
	it("has correct defaults", () => {
		const state = useSettingsStore.getState();
		expect(state.fontFamily).toContain("JetBrainsMonoNL");
		expect(state.fontSize).toBe(14);
		expect(state.theme).toBe("default");
		expect(state.sidebarCollapsed).toBe(false);
		expect(state.sidebarSplitRatio).toBe(0.4);
	});

	it("setFontFamily updates fontFamily", () => {
		useSettingsStore.getState().setFontFamily("Fira Code");
		expect(useSettingsStore.getState().fontFamily).toBe("Fira Code");
	});

	it("setFontSize updates fontSize", () => {
		useSettingsStore.getState().setFontSize(18);
		expect(useSettingsStore.getState().fontSize).toBe(18);
	});

	it("setTheme calls getTheme, applyTheme, setAllTerminalsTheme", () => {
		useSettingsStore.getState().setTheme("dracula");
		expect(mockGetTheme).toHaveBeenCalledWith("dracula");
		expect(mockApplyTheme).toHaveBeenCalled();
		expect(mockSetAllTerminalsTheme).toHaveBeenCalled();
		expect(useSettingsStore.getState().theme).toBe("dracula");
	});

	it("toggleSidebar flips sidebarCollapsed", () => {
		expect(useSettingsStore.getState().sidebarCollapsed).toBe(false);
		useSettingsStore.getState().toggleSidebar();
		expect(useSettingsStore.getState().sidebarCollapsed).toBe(true);
		useSettingsStore.getState().toggleSidebar();
		expect(useSettingsStore.getState().sidebarCollapsed).toBe(false);
	});

	it("setSidebarSplitRatio updates ratio", () => {
		useSettingsStore.getState().setSidebarSplitRatio(0.6);
		expect(useSettingsStore.getState().sidebarSplitRatio).toBe(0.6);
	});
});
