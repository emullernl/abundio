// These tests guard the markup contract only: the classes and inline styles
// that make each segment ellipsise and the right cluster stay put. jsdom does
// no layout, so none of them can show that the bar stays on one line — that
// rests on the manual `demo:web` check at several window widths.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useAppMetrics", () => ({ useAppMetrics: () => null }));
// The pill loads its summary over IPC; it has its own shrink style and is not
// what these tests are about.
vi.mock("../WorkspaceEnv/InjectedBundlePill", () => ({
	InjectedBundlePill: () => null,
}));
// Same for the version button: it asks Rust for the version once. Leaving the
// promise pending keeps the button out of the bar.
vi.mock("../../lib/ipc", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../lib/ipc")>();
	return {
		...actual,
		updates: { ...actual.updates, appVersion: () => new Promise(() => {}) },
	};
});

import { NAME_CAP } from "../../lib/statusBarLayout";
import { useProfileStore } from "../../stores/profileStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { SHRINK_RANK, StatusBar, segmentFloor } from "../StatusBar";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = "/Users/someone/code/a/very/deep/project-folder";
const BRANCH = "feature/a-rather-long-branch-name";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(): HTMLDivElement {
	const el = document.createElement("div");
	document.body.appendChild(el);
	container = el;
	root = createRoot(el);
	act(() => {
		root?.render(<StatusBar />);
	});
	return el;
}

function seedWorkspace() {
	useWorkspaceStore.setState({
		activeWorkspaceId: "w1",
		activeTabByWorkspace: { w1: "t1" },
		workspaces: [
			{
				id: "w1",
				name: "A long workspace name",
				rootFolder: ROOT,
				tabs: [{ id: "t1", workspaceId: "w1", name: "A long tab name" }],
			},
		],
	} as never);
	useWorkspaceGitStore.setState({
		byWorkspaceId: { w1: { isGitRepo: true, currentBranch: BRANCH } },
	} as never);
}

/** The segment (outer span) carrying a given `title`. */
function segment(el: HTMLElement, title: string): HTMLElement {
	const found = el.querySelector<HTMLElement>(`[title="${title}"]`);
	if (!found) throw new Error(`no element titled ${title}`);
	return found;
}

beforeEach(() => {
	useWindowUiStore.setState({
		fleetConsoleOpen: false,
		statisticsOverlayOpen: false,
		focusedTileId: null,
	} as never);
	useProfileStore.setState({ activeProfileId: null, profiles: [] } as never);
});

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	useWorkspaceStore.setState({
		activeWorkspaceId: null,
		workspaces: [],
	} as never);
	useWorkspaceGitStore.setState({ byWorkspaceId: {} } as never);
});

describe("StatusBar", () => {
	it("truncates each left-cluster segment and titles it with the full value", () => {
		seedWorkspace();
		const el = render();

		for (const title of [
			"A long workspace name",
			ROOT,
			BRANCH,
			"A long tab name",
		]) {
			const seg = segment(el, title);
			expect(seg.className).toContain("whitespace-nowrap");
			expect(seg.querySelector(".truncate")).not.toBeNull();
		}
		// The folder shows the shortened form but its tooltip is the raw path.
		expect(segment(el, ROOT).textContent).toBe(
			"~/code/a/very/deep/project-folder",
		);
	});

	it("shrinks folder first, then tab, then branch, then workspace name", () => {
		seedWorkspace();
		const el = render();
		const shrink = (title: string) =>
			Number(segment(el, title).style.flexShrink);

		expect(shrink(ROOT)).toBe(SHRINK_RANK.folder);
		expect(shrink("A long tab name")).toBe(SHRINK_RANK.tab);
		expect(shrink(BRANCH)).toBe(SHRINK_RANK.branch);
		expect(shrink("A long workspace name")).toBe(SHRINK_RANK.name);
		expect(shrink(ROOT)).toBeGreaterThan(shrink("A long tab name"));
		expect(shrink("A long tab name")).toBeGreaterThan(shrink(BRANCH));
		expect(shrink(BRANCH)).toBeGreaterThan(shrink("A long workspace name"));
	});

	it("pins the right cluster and truncates the profile name", () => {
		seedWorkspace();
		useProfileStore.setState({
			activeProfileId: "p1",
			profiles: [{ id: "p1", name: "A very long profile name" }],
		} as never);
		const el = render();

		const profile = segment(el, "A very long profile name");
		expect(profile.className).toContain("truncate");
		expect(profile.style.maxWidth).toBe(NAME_CAP);
		const cluster = profile.closest(".flex-shrink-0.whitespace-nowrap");
		expect(cluster).not.toBeNull();
	});

	it("truncates the no-workspace label", () => {
		const el = render();
		const label = Array.from(el.querySelectorAll("span")).find(
			(s) => s.textContent === "No active workspace",
		);
		expect(label?.className).toContain("truncate");
		expect(label?.className).toContain("min-w-0");
	});

	it("exempts only one-character labels from the floor", () => {
		expect(segmentFloor("A")).toBe("auto");
		expect(segmentFloor("~")).toBe("auto");
		// Three wide glyphs are wider than the floor and must still shrink.
		expect(segmentFloor("WWW")).toBe(32);
		expect(segmentFloor("編集中")).toBe(32);
		expect(segmentFloor("A long tab name")).toBe(32);
	});

	it("keeps the detached marker whole", () => {
		seedWorkspace();
		useWorkspaceGitStore.setState({
			byWorkspaceId: { w1: { isGitRepo: true, currentBranch: "HEAD" } },
		} as never);
		const el = render();
		const seg = segment(el, "Detached HEAD");
		expect(seg.style.flexShrink).toBe("0");
		expect(seg.style.minWidth).toBe("auto");
	});

	it("exempts a one-character tab from the floor", () => {
		seedWorkspace();
		useWorkspaceStore.setState((s) => ({
			workspaces: s.workspaces.map((w) => ({
				...w,
				tabs: [{ ...w.tabs[0], name: "1" }],
			})),
		}));
		const el = render();
		expect(segment(el, "1").style.minWidth).toBe("auto");
		expect(segment(el, ROOT).style.minWidth).toBe("32px");
	});
});
