import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openDialog = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));

vi.mock("../../../lib/ipc", () => ({
	fs: { readFile: vi.fn() },
}));

import { fs } from "../../../lib/ipc";
import { EnvImportDialog } from "../EnvImportDialog";

const WS_FOLDER = "/repos/app";

describe("EnvImportDialog file picker", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let imported: { name: string; value: string }[] | null;

	beforeEach(() => {
		vi.clearAllMocks();
		imported = null;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	function renderDialog() {
		act(() => {
			root.render(
				<EnvImportDialog
					bundle="production"
					existingNames={["DATABASE_URL"]}
					workspaceFolder={WS_FOLDER}
					onImport={(entries) => {
						imported = entries;
					}}
					onClose={() => {}}
				/>,
			);
		});
	}

	const chooseButton = () =>
		Array.from(container.querySelectorAll("button")).find((b) =>
			b.textContent?.includes("Choose file"),
		);

	const clickChoose = async () => {
		await act(async () => {
			chooseButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
	};

	it("opens the picker in the workspace folder", async () => {
		openDialog.mockResolvedValue(null);
		renderDialog();
		await clickChoose();

		expect(openDialog).toHaveBeenCalledWith(
			expect.objectContaining({ directory: false, defaultPath: WS_FOLDER }),
		);
	});

	// `.env` has no extension and `.env.production`'s is "production" — any
	// filter would hide exactly the files people are looking for.
	it("applies no extension filter", async () => {
		openDialog.mockResolvedValue(null);
		renderDialog();
		await clickChoose();

		expect(openDialog.mock.calls[0][0]).not.toHaveProperty("filters");
	});

	it("loads the chosen file into the preview", async () => {
		openDialog.mockResolvedValue("/repos/app/.env.production");
		vi.mocked(fs.readFile).mockResolvedValue({
			fileType: "text",
			content: "API_PORT=8080\nDATABASE_URL=postgres://x",
			mime: null,
			size: 40,
		});
		renderDialog();
		await clickChoose();

		expect(container.querySelector("textarea")?.value).toContain("API_PORT");
		expect(container.textContent).toContain("/repos/app/.env.production");
		// Preview counts come from the parser, and one name already exists.
		expect(container.textContent).toContain("2");
		expect(container.textContent).toMatch(/will overwrite/i);
	});

	it("reports a file it cannot read as text instead of importing junk", async () => {
		openDialog.mockResolvedValue("/repos/app/logo.png");
		vi.mocked(fs.readFile).mockResolvedValue({
			fileType: "binary",
			content: null,
			mime: null,
			size: 900,
		});
		renderDialog();
		await clickChoose();

		expect(container.textContent).toMatch(/isn't readable as text/i);
		expect(container.querySelector("textarea")?.value).toBe("");
	});

	it("surfaces a read failure rather than failing silently", async () => {
		openDialog.mockResolvedValue("/repos/app/.env");
		vi.mocked(fs.readFile).mockRejectedValue("permission denied");
		renderDialog();
		await clickChoose();

		expect(container.textContent).toContain("permission denied");
	});

	it("does nothing when the picker is cancelled", async () => {
		openDialog.mockResolvedValue(null);
		renderDialog();
		await clickChoose();

		expect(fs.readFile).not.toHaveBeenCalled();
		expect(container.querySelector("textarea")?.value).toBe("");
	});

	it("accepts the array form the picker can return", async () => {
		openDialog.mockResolvedValue(["/repos/app/.env"]);
		vi.mocked(fs.readFile).mockResolvedValue({
			fileType: "text",
			content: "A=1",
			mime: null,
			size: 3,
		});
		renderDialog();
		await clickChoose();

		expect(fs.readFile).toHaveBeenCalledWith("/repos/app/.env");
	});

	// The path label describes the loaded text; editing makes it a lie.
	it("drops the source path once the text is edited by hand", async () => {
		openDialog.mockResolvedValue("/repos/app/.env");
		vi.mocked(fs.readFile).mockResolvedValue({
			fileType: "text",
			content: "A=1",
			mime: null,
			size: 3,
		});
		renderDialog();
		await clickChoose();
		expect(container.textContent).toContain("/repos/app/.env");

		const textarea = container.querySelector("textarea");
		if (!textarea) throw new Error("textarea missing");
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			setter?.call(textarea, "A=1\nB=2");
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});

		expect(container.textContent).not.toContain("/repos/app/.env");
	});

	it("imports the parsed entries from a loaded file", async () => {
		openDialog.mockResolvedValue("/repos/app/.env");
		vi.mocked(fs.readFile).mockResolvedValue({
			fileType: "text",
			content: 'export A=1\nB="two"\n# comment',
			mime: null,
			size: 30,
		});
		renderDialog();
		await clickChoose();

		const importButton = Array.from(container.querySelectorAll("button")).find(
			(b) => b.textContent?.startsWith("Import "),
		);
		act(() => {
			importButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(imported).toEqual([
			{ name: "A", value: "1" },
			{ name: "B", value: "two" },
		]);
	});
});
