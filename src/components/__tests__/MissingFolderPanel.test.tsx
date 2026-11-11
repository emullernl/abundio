import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { WorkspaceWithTabs } from "../../lib/types";
import { useWorkspaceRemoveRequestStore } from "../../stores/workspaceRemoveRequestStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { MissingFolderPanel } from "../MissingFolderPanel";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ws = {
	id: "ws-1",
	name: "acme-web",
	rootFolder: "/Volumes/ssd/acme-web",
	tabs: [],
} as unknown as WorkspaceWithTabs;

describe("MissingFolderPanel (ADR-0053)", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		useWorkspaceRemoveRequestStore.setState({ requestedId: null });
		act(() => root.render(<MissingFolderPanel workspace={ws} />));
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const button = (label: string) =>
		[...container.querySelectorAll("button")].find(
			(b) => b.textContent === label,
		) as HTMLButtonElement;

	it("names the folder", () => {
		expect(container.textContent).toContain("Folder not found");
		expect(container.textContent).toContain("/Volumes/ssd/acme-web");
	});

	it("Remove workspace asks the sidebar for its confirm", () => {
		act(() => button("Remove workspace").click());
		expect(useWorkspaceRemoveRequestStore.getState().requestedId).toBe("ws-1");
	});

	it("Try again re-checks, and says so when the folder is still missing", async () => {
		const refresh = vi.fn(async () => {
			useWorkspaceStore.setState({ missingFolderIds: new Set(["ws-1"]) });
		});
		useWorkspaceStore.setState({ refreshMissingFolders: refresh });
		await act(async () => button("Try again").click());
		expect(refresh).toHaveBeenCalled();
		expect(container.textContent).toContain("Still not found.");
	});
});
