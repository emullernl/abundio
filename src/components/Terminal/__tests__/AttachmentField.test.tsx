import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/ipc", () => ({
	promptAttachments: { fromClipboard: vi.fn() },
}));

import { promptAttachments } from "../../../lib/ipc";
import { AttachmentField } from "../AttachmentField";

const fromClipboard = vi.mocked(promptAttachments.fromClipboard);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	fromClipboard.mockReset();
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

function render(paths: string[], multiple: boolean, onChange = vi.fn()) {
	act(() => {
		root.render(
			<AttachmentField multiple={multiple} paths={paths} onChange={onChange} />,
		);
	});
	return onChange;
}

function pasteButton(): HTMLButtonElement {
	const btn = Array.from(container.querySelectorAll("button")).find((b) =>
		b.textContent?.includes("Paste from clipboard"),
	);
	if (!btn) throw new Error("no Paste from clipboard button");
	return btn;
}

async function clickPaste() {
	await act(async () => {
		pasteButton().click();
	});
}

describe("AttachmentField — Paste from clipboard", () => {
	it("appends the saved clipboard image to a multi-file value", async () => {
		fromClipboard.mockResolvedValue(["/att/abc.png"]);
		const onChange = render(["/a.txt"], true);
		await clickPaste();
		expect(onChange).toHaveBeenCalledWith(["/a.txt", "/att/abc.png"]);
	});

	it("replaces the value when only one file is allowed", async () => {
		fromClipboard.mockResolvedValue(["/att/abc.png"]);
		const onChange = render(["/a.txt"], false);
		await clickPaste();
		expect(onChange).toHaveBeenCalledWith(["/att/abc.png"]);
	});

	it("says so when the clipboard holds no image, and changes nothing", async () => {
		fromClipboard.mockResolvedValue([]);
		const onChange = render([], true);
		await clickPaste();
		expect(onChange).not.toHaveBeenCalled();
		expect(container.textContent).toContain(
			"no image or file on the clipboard",
		);
	});

	it("attaches every copied file when several are allowed", async () => {
		fromClipboard.mockResolvedValue(["/x/one.png", "/x/two.pdf"]);
		const onChange = render([], true);
		await clickPaste();
		expect(onChange).toHaveBeenCalledWith(["/x/one.png", "/x/two.pdf"]);
	});

	it("shows a clipboard error", async () => {
		fromClipboard.mockRejectedValue("Clipboard error: read failed");
		const onChange = render([], true);
		await clickPaste();
		expect(onChange).not.toHaveBeenCalled();
		expect(container.textContent).toContain("read failed");
	});
});
