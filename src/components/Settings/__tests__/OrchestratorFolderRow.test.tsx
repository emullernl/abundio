import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const folder = vi.fn();
const setFolder = vi.fn();
const reveal = vi.fn(() => Promise.resolve());
vi.mock("../../../lib/ipc", async (orig) => ({
	...(await orig<typeof import("../../../lib/ipc")>()),
	orchestrator: {
		folder: (...a: unknown[]) => folder(...a),
		setFolder: (...a: unknown[]) => setFolder(...a),
	},
	fs: { revealInFolder: (...a: unknown[]) => reveal(...(a as [])) },
}));
vi.mock("@tauri-apps/api/path", () => ({
	homeDir: () => Promise.resolve("/Users/me"),
}));
const pick = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: (...a: unknown[]) => pick(...a),
}));

const { OrchestratorFolderRow } = await import("../OrchestratorFolderRow");

const flush = () => act(async () => {});
const button = (root: HTMLElement, text: string) =>
	Array.from(root.querySelectorAll("button")).find(
		(b) => b.textContent === text,
	);

describe("OrchestratorFolderRow", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		vi.clearAllMocks();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("shows the folder with ~, and Reset only away from the default", async () => {
		const path =
			"/Users/me/Library/Application Support/abundio/orchestrator/Personal";
		folder.mockResolvedValue({ path, isDefault: true, defaultPath: path });
		act(() => root.render(<OrchestratorFolderRow profileId="p" />));
		await flush();
		expect(container.textContent).toContain(
			"~/Library/Application Support/abundio/orchestrator/Personal",
		);
		expect(button(container, "Reset to default")).toBeUndefined();
		act(() => button(container, "Show in Finder")?.click());
		expect(reveal).toHaveBeenCalled();
	});

	it("asks before moving the Orchestrator, and shows a refusal", async () => {
		folder.mockResolvedValue({
			path: "/Users/me/Orch",
			isDefault: false,
			defaultPath: "/data/orchestrator/Personal",
		});
		pick.mockResolvedValue("/Users/me/project");
		setFolder.mockRejectedValue("Choose an empty folder");
		act(() => root.render(<OrchestratorFolderRow profileId="p" />));
		await flush();
		await act(async () => button(container, "Choose…")?.click());
		await flush();
		// Nothing moves until the user says yes.
		expect(setFolder).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("starts a new conversation");
		await act(async () => button(document.body, "Move")?.click());
		await flush();
		expect(setFolder).toHaveBeenCalledWith("p", "/Users/me/project");
		expect(container.textContent).toContain("Choose an empty folder");
	});

	it("offers Reset for a Profile still in its old id folder", async () => {
		folder.mockResolvedValue({
			path: "/data/orchestrator/0000-1/Orchestrator",
			isDefault: true,
			defaultPath: "/data/orchestrator/Personal",
		});
		act(() => root.render(<OrchestratorFolderRow profileId="p" />));
		await flush();
		expect(button(container, "Reset to default")).toBeDefined();
	});
});
