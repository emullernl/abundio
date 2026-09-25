import { beforeEach, describe, expect, it } from "vitest";
import { useWindowUiStore } from "../windowUiStore";

/** Fold state for Worktree sets — see the "Folded set" entry in CONTEXT.md. */
describe("windowUiStore — folded sets", () => {
	beforeEach(() => {
		useWindowUiStore.setState({ foldedSetKeys: [] });
	});

	it("starts with nothing folded", () => {
		expect(useWindowUiStore.getState().foldedSetKeys).toEqual([]);
	});

	it("toggles a set folded and back", () => {
		const { toggleSetFolded } = useWindowUiStore.getState();
		toggleSetFolded("/repo/.git");
		expect(useWindowUiStore.getState().foldedSetKeys).toEqual(["/repo/.git"]);
		toggleSetFolded("/repo/.git");
		expect(useWindowUiStore.getState().foldedSetKeys).toEqual([]);
	});

	it("keeps sets independent", () => {
		const { toggleSetFolded } = useWindowUiStore.getState();
		toggleSetFolded("/a/.git");
		toggleSetFolded("/b/.git");
		toggleSetFolded("/a/.git");
		expect(useWindowUiStore.getState().foldedSetKeys).toEqual(["/b/.git"]);
	});

	it("setSetFolded is idempotent — no duplicate keys, no-op when unchanged", () => {
		const { setSetFolded } = useWindowUiStore.getState();
		setSetFolded("/repo/.git", true);
		const after = useWindowUiStore.getState().foldedSetKeys;
		setSetFolded("/repo/.git", true);
		// Same array identity: an unchanged call must not re-render subscribers.
		expect(useWindowUiStore.getState().foldedSetKeys).toBe(after);
		expect(after).toEqual(["/repo/.git"]);
		setSetFolded("/repo/.git", false);
		expect(useWindowUiStore.getState().foldedSetKeys).toEqual([]);
		setSetFolded("/never-folded/.git", false);
		expect(useWindowUiStore.getState().foldedSetKeys).toEqual([]);
	});

	it("persists fold state for this window", () => {
		useWindowUiStore.getState().toggleSetFolded("/repo/.git");
		const raw = localStorage.getItem("abundio-window-ui-main");
		expect(raw).toBeTruthy();
		expect(JSON.parse(raw as string).state.foldedSetKeys).toEqual([
			"/repo/.git",
		]);
	});
});

/** Fleet Console vs Statistics overlay — see ADR-0040. */
describe("windowUiStore — Fleet Console", () => {
	beforeEach(() => {
		useWindowUiStore.setState({
			fleetConsoleOpen: false,
			statisticsOverlayOpen: false,
		});
	});

	it("toggles on and off", () => {
		const { toggleFleetConsole } = useWindowUiStore.getState();
		toggleFleetConsole();
		expect(useWindowUiStore.getState().fleetConsoleOpen).toBe(true);
		toggleFleetConsole();
		expect(useWindowUiStore.getState().fleetConsoleOpen).toBe(false);
	});

	it("opening the console closes Statistics", () => {
		useWindowUiStore.setState({ statisticsOverlayOpen: true });
		useWindowUiStore.getState().toggleFleetConsole();
		const s = useWindowUiStore.getState();
		expect(s.fleetConsoleOpen).toBe(true);
		expect(s.statisticsOverlayOpen).toBe(false);
	});

	it("Statistics covers the console and closing it reveals the console", () => {
		useWindowUiStore.getState().toggleFleetConsole();
		useWindowUiStore.getState().toggleStatisticsOverlay();
		expect(useWindowUiStore.getState().fleetConsoleOpen).toBe(true);
		useWindowUiStore.getState().toggleStatisticsOverlay();
		const s = useWindowUiStore.getState();
		expect(s.statisticsOverlayOpen).toBe(false);
		expect(s.fleetConsoleOpen).toBe(true);
	});

	it("the toggle pressed under Statistics shows the console, not hides it", () => {
		useWindowUiStore.getState().toggleFleetConsole();
		useWindowUiStore.getState().toggleStatisticsOverlay();
		useWindowUiStore.getState().toggleFleetConsole();
		const s = useWindowUiStore.getState();
		expect(s.statisticsOverlayOpen).toBe(false);
		expect(s.fleetConsoleOpen).toBe(true);
	});
});
