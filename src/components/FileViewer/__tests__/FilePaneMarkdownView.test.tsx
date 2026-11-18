import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { editorActive } = vi.hoisted(() => ({
	/** The `isActive` the stub editor last rendered with; null: not mounted. */
	editorActive: { current: null as boolean | null },
}));

vi.mock("../../../lib/ipc", () => ({
	git: { conflictFile: () => new Promise(() => {}) },
	fs: {},
	fileWindows: {},
}));

vi.mock("../CodeEditor", () => ({
	CodeEditor: ({ isActive }: { isActive: boolean }) => {
		editorActive.current = isActive;
		return <div data-testid="editor" />;
	},
	getLiveEditor: () => null,
	focusEditor: vi.fn(),
	triggerEditorAction: vi.fn(),
}));

vi.mock("../RenderedMarkdownView", () => ({
	RenderedMarkdownView: ({ content }: { content: string }) => (
		<div data-testid="rendered">{content}</div>
	),
}));

import { toggleMarkdownView } from "../../../lib/markdownViewToggles";
import type { MarkdownView } from "../../../lib/types";
import {
	type FilePaneState,
	useExplorerStore,
} from "../../../stores/explorerStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useWorkspaceGitStore } from "../../../stores/workspaceGitStore";
import { FilePane } from "../FilePane";

const PANE = "pane-1";
const PATH = "/w/README.md";

function paneState(over: Partial<FilePaneState> = {}): FilePaneState {
	return {
		filePath: PATH,
		fileName: "README.md",
		fileType: "text",
		content: "# Hello",
		mime: null,
		isDirty: false,
		language: "markdown",
		diffSource: null,
		externallyChanged: false,
		deletedOnDisk: false,
		loading: false,
		diffOriginal: null,
		diffModified: null,
		diffSection: null,
		isDeleted: false,
		...over,
	};
}

let root: Root;
let host: HTMLDivElement;
const onViewChange = vi.fn<(view: MarkdownView) => void>();

function render(props: { markdownView?: MarkdownView; isFocused?: boolean }) {
	act(() => {
		root.render(
			<FilePane
				paneId={PANE}
				filePath={PATH}
				cwd="/w"
				workspaceId="ws-1"
				isFocused={props.isFocused ?? true}
				onFocus={() => {}}
				embedded={{ onClose: () => {}, closeLabel: "Close Tab" }}
				markdownView={props.markdownView}
				onMarkdownViewChange={onViewChange}
			/>,
		);
	});
}

const shown = (id: string) => {
	const el = host.querySelector(`[data-testid="${id}"]`);
	if (!el) return false;
	// The editor stays mounted, hidden, once it has been shown.
	return (el.parentElement as HTMLElement).style.display !== "none";
};

const switchButton = (label: string) =>
	[...host.querySelectorAll("button")].find((b) => b.textContent === label);

beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	editorActive.current = null;
	onViewChange.mockReset();
	useSettingsStore.setState({ markdownOpenRendered: true });
	useExplorerStore.setState({
		filePanes: { [PANE]: paneState() },
		pendingGotoLine: null,
		registerFilePane: vi.fn(),
		unregisterFilePane: vi.fn(),
	});
	useWorkspaceGitStore.setState({ byWorkspaceId: {} });
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe("a markdown File pane's views", () => {
	it("opens rendered, without mounting the editor", () => {
		render({});
		expect(shown("rendered")).toBe(true);
		expect(editorActive.current).toBeNull();
	});

	it("opens as source when the setting is off", () => {
		useSettingsStore.setState({ markdownOpenRendered: false });
		render({});
		expect(shown("editor")).toBe(true);
		expect(shown("rendered")).toBe(false);
	});

	it("keeps its stored view whatever the setting", () => {
		render({ markdownView: "source" });
		expect(shown("editor")).toBe(true);
	});

	it("switches to source from the title bar and remembers it", () => {
		render({});
		act(() => switchButton("Source")?.click());
		expect(onViewChange).toHaveBeenCalledWith("source");
		expect(shown("editor")).toBe(true);
		expect(editorActive.current).toBe(true);
	});

	it("keeps the editor mounted but inactive while rendered again", () => {
		render({ markdownView: "source" });
		act(() => switchButton("Rendered")?.click());
		expect(shown("rendered")).toBe(true);
		expect(shown("editor")).toBe(false);
		// Hidden, it must never take keyboard focus.
		expect(editorActive.current).toBe(false);
	});

	it("switches with the shortcut's toggle", () => {
		render({});
		act(() => {
			expect(toggleMarkdownView(PANE)).toBe(true);
		});
		expect(onViewChange).toHaveBeenLastCalledWith("source");
	});

	it("shows source for a jump to a line in its file", () => {
		render({});
		act(() => {
			useExplorerStore.setState({
				pendingGotoLine: { filePath: PATH, line: 12 },
			});
		});
		expect(onViewChange).toHaveBeenCalledWith("source");
		expect(shown("editor")).toBe(true);
	});

	it("waits until it is focused before taking a jump", () => {
		render({ isFocused: false });
		act(() => {
			useExplorerStore.setState({
				pendingGotoLine: { filePath: PATH, line: 12 },
			});
		});
		expect(onViewChange).not.toHaveBeenCalled();
	});

	it("stays on source while the file has merge conflicts", () => {
		useWorkspaceGitStore.setState({
			byWorkspaceId: {
				// biome-ignore lint/suspicious/noExplicitAny: only conflictedPaths is read
				"ws-1": { conflictedPaths: ["README.md"] } as any,
			},
		});
		render({ markdownView: "rendered" });
		expect(shown("editor")).toBe(true);
		expect(switchButton("Rendered")?.disabled).toBe(true);
		act(() => {
			toggleMarkdownView(PANE);
		});
		expect(onViewChange).not.toHaveBeenCalled();
	});

	it("has no view switch for a file that is not markdown", () => {
		useExplorerStore.setState({
			filePanes: {
				[PANE]: paneState({ filePath: "/w/a.ts", fileName: "a.ts" }),
			},
		});
		render({ markdownView: "rendered" });
		expect(shown("editor")).toBe(true);
		expect(switchButton("Rendered")).toBeUndefined();
		expect(toggleMarkdownView(PANE)).toBe(false);
	});
});
