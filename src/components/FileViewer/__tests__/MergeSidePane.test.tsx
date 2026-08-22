import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { conflictFile, liveEditor, mountedCallbacks } = vi.hoisted(() => ({
	conflictFile: vi.fn(),
	liveEditor: { current: null as unknown },
	mountedCallbacks: [] as (() => void)[],
}));

vi.mock("../../../lib/ipc", () => ({
	git: { conflictFile },
	fs: {},
}));

// A stub editor: mounting is deferred, exactly as Monaco's CDN load defers it.
vi.mock("../CodeEditor", () => ({
	CodeEditor: ({ onEditorMounted }: { onEditorMounted?: () => void }) => {
		useEffect(() => {
			if (onEditorMounted) mountedCallbacks.push(onEditorMounted);
		}, [onEditorMounted]);
		return null;
	},
	getLiveEditor: () => liveEditor.current,
}));

import { useExplorerStore } from "../../../stores/explorerStore";
import { MergeSidePane } from "../MergeSidePane";

const SOURCE = [
	"before",
	"<<<<<<< HEAD",
	"ours line",
	"=======",
	"theirs line",
	">>>>>>> main",
	"after",
	"",
].join("\n");

const OURS = ["before", "ours line", "after", ""].join("\n");

function makeEditor() {
	const collections: unknown[][] = [];
	return {
		collections,
		getModel: () => ({ getLineCount: () => 4 }),
		createDecorationsCollection: (decos: unknown[]) => {
			collections.push(decos);
			return { set: vi.fn(), clear: vi.fn() };
		},
		revealRangeInCenter: vi.fn(),
	};
}

describe("MergeSidePane", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		vi.clearAllMocks();
		mountedCallbacks.length = 0;
		liveEditor.current = null;
		conflictFile.mockResolvedValue({
			filePath: "a.ts",
			kind: "both_modified",
			isBinary: false,
			base: null,
			ours: OURS,
			theirs: null,
		});
		useExplorerStore.setState({
			filePanes: {
				// biome-ignore lint/suspicious/noExplicitAny: partial pane state
				src: { filePath: "/repo/a.ts", content: SOURCE } as any,
			},
		});
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	async function render() {
		await act(async () => {
			root.render(
				<MergeSidePane
					paneId="side-1"
					sourcePaneId="src"
					side="current"
					cwd="/repo"
					onFocus={vi.fn()}
				/>,
			);
		});
	}

	it("decorates once the editor mounts, not before", async () => {
		// The regression: Monaco loads asynchronously, so the editor does not
		// exist on the render that first has content. Without waiting for the
		// mount signal the pane stayed undecorated until some unrelated change
		// happened to re-trigger the effect.
		const editor = makeEditor();
		liveEditor.current = editor;
		await render();

		// Content has arrived, but the mount signal has not been delivered yet.
		expect(editor.collections).toHaveLength(0);

		await act(async () => {
			for (const fn of mountedCallbacks) fn();
		});

		expect(editor.collections.length).toBeGreaterThan(0);
	});

	it("marks the conflict region and dims the rest", async () => {
		const editor = makeEditor();
		liveEditor.current = editor;
		await render();
		await act(async () => {
			for (const fn of mountedCallbacks) fn();
		});

		const decos = editor.collections[editor.collections.length - 1] as {
			options: { className?: string };
		}[];
		const classes = decos.map((d) => d.options.className ?? "").join(" ");
		expect(classes).toContain("abundio-side-hit");
		expect(classes).toContain("abundio-side-current");
		expect(classes).toContain("abundio-side-dim");
	});

	it("shows the side's name", async () => {
		await render();
		expect(container.textContent).toContain("Current");
		expect(container.textContent).toContain("read-only");
	});

	it("says so when the side does not exist", async () => {
		conflictFile.mockResolvedValue({
			filePath: "a.ts",
			kind: "deleted_by_them",
			isBinary: false,
			base: null,
			ours: OURS,
			theirs: null,
		});
		await act(async () => {
			root.render(
				<MergeSidePane
					paneId="side-1"
					sourcePaneId="src"
					side="incoming"
					cwd="/repo"
					onFocus={vi.fn()}
				/>,
			);
		});
		expect(container.textContent).toContain("does not exist");
	});

	it("refuses to render text for a binary conflict", async () => {
		conflictFile.mockResolvedValue({
			filePath: "a.ts",
			kind: "both_modified",
			isBinary: true,
			base: null,
			ours: null,
			theirs: null,
		});
		await render();
		expect(container.textContent).toContain("Binary file");
	});
});
