import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { conflictFile, stagePath, deletePath } = vi.hoisted(() => ({
	conflictFile: vi.fn(),
	stagePath: vi.fn(() => Promise.resolve()),
	deletePath: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../lib/ipc", () => ({
	git: {
		conflictFile,
		stagePath,
		workspacesSummary: vi.fn(() => Promise.resolve([])),
	},
	fs: { deletePath },
	workspaces: { update: vi.fn(() => Promise.resolve()) },
}));

import { parseConflicts } from "../../../lib/conflictMarkers";
import { useGitChangesStore } from "../../../stores/gitChangesStore";
import { ConflictToolbar } from "../ConflictToolbar";

const CONFLICTED = [
	"<<<<<<< HEAD",
	"ours",
	"=======",
	"theirs",
	">>>>>>> main",
	"",
].join("\n");

const bothModified = {
	filePath: "a.ts",
	kind: "both_modified" as const,
	isBinary: false,
	base: "b",
	ours: "o",
	theirs: "t",
};

describe("ConflictToolbar", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const onResolveAndStage = vi.fn(() => Promise.resolve());
	const onAcceptAll = vi.fn();
	const onNavigate = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		conflictFile.mockResolvedValue(bothModified);
		useGitChangesStore.setState({ operationInProgress: "merge" });
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function renderToolbar(content: string, activeBlock: number | null = null) {
		act(() => {
			root.render(
				<ConflictToolbar
					paneId="p1"
					cwd="/repo"
					relativePath="a.ts"
					absolutePath="/repo/a.ts"
					blocks={parseConflicts(content)}
					isDirty={false}
					onAcceptAll={onAcceptAll}
					onResolveAndStage={onResolveAndStage}
					mergeViewOpen={false}
					onToggleMergeView={vi.fn()}
					onToggleBase={vi.fn()}
					activeBlock={activeBlock}
					onNavigate={onNavigate}
				/>,
			);
		});
	}

	const button = (label: string) =>
		[...container.querySelectorAll("button")].find(
			(b) => b.textContent === label || b.getAttribute("aria-label") === label,
		);

	it("shows the remaining count as the navigator total", () => {
		renderToolbar(CONFLICTED + CONFLICTED);
		expect(container.textContent).toContain("/2");
		expect(
			container.querySelector('[title="2 conflicts remaining"]'),
		).not.toBeNull();
	});

	it("uses the singular in the count tooltip", () => {
		renderToolbar(CONFLICTED);
		expect(
			container.querySelector('[title="1 conflict remaining"]'),
		).not.toBeNull();
	});

	it("keeps Resolve & stage enabled while markers remain", () => {
		// Git lets you stage a file with markers in it; Abundio should not be
		// stricter than git without a reason it can state.
		renderToolbar(CONFLICTED);
		expect(button("Resolve & stage")?.disabled).toBe(false);
	});

	it("still offers Resolve & stage when an agent removed the markers", () => {
		// The whole point of keying visibility off the index: the caller renders
		// this even with zero blocks, and the button must survive.
		renderToolbar("resolved by an agent\n");
		expect(container.textContent).toContain("No conflict markers left");
		expect(button("Resolve & stage")).toBeDefined();
		expect(button("Accept all current")).toBeUndefined();
	});

	it("stages and then tells the user how to finish", async () => {
		renderToolbar(CONFLICTED);
		await act(async () => {
			button("Resolve & stage")?.click();
		});
		expect(onResolveAndStage).toHaveBeenCalledOnce();
		expect(container.textContent).toContain("Staged.");
		expect(container.textContent).toContain("git merge --continue");
	});

	it("names the right continue command for a rebase", async () => {
		useGitChangesStore.setState({ operationInProgress: "rebase" });
		renderToolbar(CONFLICTED);
		await act(async () => {
			button("Resolve & stage")?.click();
		});
		expect(container.textContent).toContain("git rebase --continue");
	});

	it("forwards accept-all to the caller", () => {
		renderToolbar(CONFLICTED);
		act(() => {
			button("Accept all incoming")?.click();
		});
		expect(onAcceptAll).toHaveBeenCalledWith("incoming");
	});

	describe("marker-less conflicts", () => {
		it("describes a delete conflict without naming a side", async () => {
			// "Deleted by them" is backwards during a rebase, and these files have
			// no marker labels to read the truth from.
			conflictFile.mockResolvedValue({
				...bothModified,
				kind: "deleted_by_them",
				theirs: null,
			});
			await act(async () => {
				renderToolbar("still here\n");
			});
			expect(container.textContent).toContain(
				"changed on one side of the merge and deleted on the other",
			);
			expect(container.textContent).not.toMatch(/\btheirs\b|\bours\b/i);
			expect(button("Keep the file")).toBeDefined();
			expect(button("Delete the file")).toBeDefined();
		});

		it("deletes then stages when the user drops the file", async () => {
			conflictFile.mockResolvedValue({
				...bothModified,
				kind: "deleted_by_us",
				ours: null,
			});
			await act(async () => {
				renderToolbar("still here\n");
			});
			await act(async () => {
				button("Delete the file")?.click();
			});
			expect(deletePath).toHaveBeenCalledWith("/repo/a.ts");
			expect(stagePath).toHaveBeenCalledWith("/repo", "a.ts");
		});

		it("sends binary conflicts to the terminal with no buttons", async () => {
			conflictFile.mockResolvedValue({
				...bothModified,
				isBinary: true,
				base: null,
				ours: null,
				theirs: null,
			});
			await act(async () => {
				renderToolbar("binary\n");
			});
			expect(container.textContent).toContain("Binary conflict");
			expect(container.querySelectorAll("button")).toHaveLength(0);
		});
	});
});

describe("conflict navigator", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const onNavigate = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		conflictFile.mockResolvedValue(bothModified);
		useGitChangesStore.setState({ operationInProgress: "merge" });
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function render(content: string, activeBlock: number | null) {
		act(() => {
			root.render(
				<ConflictToolbar
					paneId="p1"
					cwd="/repo"
					relativePath="a.ts"
					absolutePath="/repo/a.ts"
					blocks={parseConflicts(content)}
					isDirty={false}
					onAcceptAll={vi.fn()}
					onResolveAndStage={vi.fn(() => Promise.resolve())}
					mergeViewOpen={false}
					onToggleMergeView={vi.fn()}
					onToggleBase={vi.fn()}
					activeBlock={activeBlock}
					onNavigate={onNavigate}
				/>,
			);
		});
	}

	const THREE = CONFLICTED + CONFLICTED + CONFLICTED;
	const arrow = (label: string) =>
		container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);

	it("shows position over total", () => {
		render(THREE, 1);
		expect(container.textContent).toContain("2/3");
	});

	it("shows a placeholder when the caret is outside every block", () => {
		render(THREE, null);
		expect(container.textContent).toContain("—/3");
	});

	it("steps forward and back", () => {
		render(THREE, 1);
		act(() => arrow("Next conflict")?.click());
		expect(onNavigate).toHaveBeenLastCalledWith(2);
		act(() => arrow("Previous conflict")?.click());
		expect(onNavigate).toHaveBeenLastCalledWith(0);
	});

	it("wraps at both ends", () => {
		// A dead button at the end is worse than continuing round.
		render(THREE, 2);
		act(() => arrow("Next conflict")?.click());
		expect(onNavigate).toHaveBeenLastCalledWith(0);

		render(THREE, 0);
		act(() => arrow("Previous conflict")?.click());
		expect(onNavigate).toHaveBeenLastCalledWith(2);
	});

	it("starts at the first block when nothing is active", () => {
		render(THREE, null);
		act(() => arrow("Next conflict")?.click());
		expect(onNavigate).toHaveBeenLastCalledWith(0);
	});

	it("is replaced by a done message once the markers are gone", () => {
		render("all resolved\n", null);
		expect(arrow("Next conflict")).toBeNull();
		expect(container.textContent).toContain("No conflict markers left");
	});
});
