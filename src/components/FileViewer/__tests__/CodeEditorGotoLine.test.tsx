import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mountEditor, calls } = vi.hoisted(() => ({
	/** Mounts the fake Monaco: it loads asynchronously, so the test decides when. */
	mountEditor: { current: null as null | (() => void) },
	calls: [] as string[],
}));

/** Stands in for any part of Monaco: every property, call and `new` works. */
function anything(): unknown {
	// biome-ignore lint/complexity/useArrowFunction: only a plain function can be `new`ed, and Monaco's Emitter is
	const f = function () {};
	return new Proxy(f, {
		get: (_t, k) =>
			k === "then"
				? undefined
				: k === Symbol.toPrimitive
					? () => ""
					: anything(),
		apply: () => anything(),
		construct: () => anything() as object,
	});
}

/** A fake editor: every method is a spy that records itself. */
function fakeEditor() {
	return new Proxy(
		{},
		{
			get: (_t, name: string) => {
				if (name === "getModel") return () => null;
				return (...args: unknown[]) => {
					calls.push(`${name}(${JSON.stringify(args[0] ?? "")})`);
					return { dispose: () => {}, set: () => {}, clear: () => {} };
				};
			},
		},
	);
}

vi.mock("@monaco-editor/react", () => ({
	default: ({ onMount }: { onMount: (ed: unknown, m: unknown) => void }) => {
		mountEditor.current = () => onMount(fakeEditor(), anything());
		return null;
	},
	useMonaco: () => null,
}));
vi.mock("../../../lib/monacoShared", () => ({ defineAbundioTheme: () => {} }));
vi.mock("../../../lib/monacoKeymap", () => ({
	registerMonacoForKeymap: () => {},
}));
vi.mock("../../../lib/themes", async (orig) => ({
	...(await orig<typeof import("../../../lib/themes")>()),
	setMonacoInstance: () => {},
}));
vi.mock("../../../lib/terminalManager", () => ({
	setAllTerminalsFontSize: () => {},
}));
vi.mock("../../../lib/scrollSync", () => ({
	registerSyncEditor: () => {},
	unregisterSyncEditor: () => {},
}));
vi.mock("../../../lib/ipc");

import { useExplorerStore } from "../../../stores/explorerStore";
import { CodeEditor } from "../CodeEditor";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	calls.length = 0;
	mountEditor.current = null;
	useExplorerStore.setState({
		filePanes: {
			p: { filePath: "/w/a.md" } as never,
		},
		pendingGotoLine: { filePath: "/w/a.md", line: 12 },
	});
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe("CodeEditor's pending go-to-line", () => {
	it("is applied once Monaco mounts, when it was set before", () => {
		act(() => {
			root.render(
				<CodeEditor
					tabId="p"
					isActive
					content="text"
					language="markdown"
					initialEditorState={null}
					onChange={() => {}}
				/>,
			);
		});
		// Monaco has not loaded yet: the jump waits.
		expect(useExplorerStore.getState().pendingGotoLine).not.toBeNull();
		act(() => mountEditor.current?.());
		expect(calls).toContain("revealLineInCenter(12)");
		expect(useExplorerStore.getState().pendingGotoLine).toBeNull();
	});
});
