import { beforeEach, describe, expect, it, vi } from "vitest";

const openOrchestratorFile = vi.fn(() => Promise.resolve({}));
vi.mock("../../orchestratorTabs", () => ({
	openOrchestratorFile: (...a: unknown[]) => openOrchestratorFile(...(a as [])),
}));
const openFileWindow = vi.fn(() => Promise.resolve());
vi.mock("../../openFileWindow", () => ({
	openFileWindow: (...a: unknown[]) => openFileWindow(...(a as [])),
	fileWindowTargetForPath: (p: string) => ({ kind: "text", filePath: p }),
}));
const fileDiff = vi.fn();
const commitFileDiff = vi.fn();
vi.mock("../../ipc", async (orig) => ({
	...(await orig<typeof import("../../ipc")>()),
	git: {
		fileDiff: (...a: unknown[]) => fileDiff(...a),
		commitFileDiff: (...a: unknown[]) => commitFileDiff(...a),
	},
}));

const { fileOpenPlace, openFileFor } = await import("../fileOpen");
const { useWorkspaceStore } = await import("../../../stores/workspaceStore");
const { useExplorerStore } = await import("../../../stores/explorerStore");

const request = (over: Record<string, unknown> = {}) => ({
	op: "file.open" as const,
	path: "/repo/src/a.ts",
	rel: "src/a.ts",
	window: false,
	focus: false,
	line: null as number | null,
	diff: false,
	preview: false,
	commit: null as string | null,
	...over,
});

const caller = (workspaceId: string) => ({
	ptyId: "pty",
	paneId: "pane",
	workspaceId,
});

describe("file open", () => {
	const openFile = vi.fn(() => Promise.resolve());
	const openDiff = vi.fn();
	const setPendingGotoLine = vi.fn();
	beforeEach(() => {
		vi.clearAllMocks();
		useWorkspaceStore.setState({
			workspaces: [
				{ id: "w", kind: "work", rootFolder: "/repo", tabs: [] },
				{ id: "o", kind: "orchestrator", rootFolder: "/orch", tabs: [] },
			] as never,
			activeWorkspaceId: "w",
		});
		useExplorerStore.setState({
			openFile,
			openDiff,
			setPendingGotoLine,
		} as never);
	});

	it("lands in a window, an Orchestrator tab or a Tab", () => {
		expect(fileOpenPlace({ window: true }, true)).toBe("window");
		expect(fileOpenPlace({ window: false }, true)).toBe("orchestrator-tab");
		expect(fileOpenPlace({ window: false }, false)).toBe("tab");
	});

	it("from the Orchestrator, opens a tab without opening the Workspace", async () => {
		const ensure = vi.fn(() => Promise.resolve());
		const reply = await openFileFor(
			caller("o"),
			request({ focus: true }),
			"w",
			ensure,
		);
		expect(reply.opened).toBe("orchestrator-tab");
		expect(ensure).not.toHaveBeenCalled();
		expect(openOrchestratorFile).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "w",
				kind: "file",
				path: "/repo/src/a.ts",
			}),
			{ focus: true },
		);
	});

	it("gives a diff tab the Workspace-relative path", async () => {
		await openFileFor(caller("o"), request({ diff: true }), "w", vi.fn());
		expect(openOrchestratorFile).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "diff", path: "src/a.ts" }),
			{ focus: false },
		);
	});

	it("elsewhere, opens a Tab without switching to it unless asked, at the line", async () => {
		const ensure = vi.fn(() => Promise.resolve());
		const reply = await openFileFor(
			caller("w"),
			request({ line: 7 }),
			"w",
			ensure,
		);
		expect(reply.opened).toBe("tab");
		expect(ensure).toHaveBeenCalled();
		expect(openFile).toHaveBeenCalledWith("w", "/repo/src/a.ts", {
			activate: false,
		});
		expect(setPendingGotoLine).toHaveBeenCalledWith({
			filePath: "/repo/src/a.ts",
			line: 7,
		});
	});

	it("opens the live diff of a file with changes", async () => {
		fileDiff.mockImplementation((_c: string, _r: string, section: string) =>
			Promise.resolve(
				section === "staged"
					? { original: "a", modified: "b" }
					: { original: "x", modified: "x" },
			),
		);
		await openFileFor(
			caller("w"),
			request({ diff: true, focus: true }),
			"w",
			vi.fn(),
		);
		expect(openDiff).toHaveBeenCalledWith(
			"w",
			"src/a.ts",
			"a",
			"b",
			"staged",
			false,
			{ activate: true },
		);
	});

	it("opens a File window with --window", async () => {
		const reply = await openFileFor(
			caller("o"),
			request({ window: true }),
			"w",
			vi.fn(),
		);
		expect(reply.opened).toBe("window");
		expect(openFileWindow).toHaveBeenCalledWith("w", {
			kind: "text",
			filePath: "/repo/src/a.ts",
		});
	});
});
