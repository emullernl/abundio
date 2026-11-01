import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const save = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
	save: (...a: unknown[]) => save(...a),
}));

import { EnvExportDialog } from "../EnvExportDialog";

describe("EnvExportDialog", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		save.mockReset();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	function render(
		overrides: Partial<Parameters<typeof EnvExportDialog>[0]> = {},
	) {
		const onExport = vi.fn().mockResolvedValue(null);
		act(() => {
			root.render(
				<EnvExportDialog
					bundle="production"
					count={3}
					inheritedCount={0}
					workspaceFolder="/tmp/proj"
					onExport={onExport}
					onClose={() => {}}
					{...overrides}
				/>,
			);
		});
		return { onExport };
	}

	const button = (label: string) =>
		Array.from(container.querySelectorAll("button")).find(
			(el) => el.textContent === label,
		) as HTMLButtonElement | undefined;

	it("names the bundle and how many variables will be written", () => {
		render();
		expect(container.textContent).toContain("production");
		expect(container.textContent).toContain("3 variables");
	});

	it("shows no plaintext preview", () => {
		render();
		// The whole point: this dialog never renders a value.
		expect(container.querySelector("textarea")).toBeNull();
		expect(container.querySelector("code")).toBeNull();
	});

	it("says how many rows are inherited and therefore left out", () => {
		render({ count: 1, inheritedCount: 2 });
		expect(container.textContent).toContain("2 variables are inherited");
	});

	// Defaults to `<folder>/<bundle>.env`, never a bare `.env` that would
	// replace the project's own file on a careless Enter.
	it("defaults the save dialog to <folder>/<bundle>.env", async () => {
		save.mockResolvedValue("/tmp/proj/production.env");
		const { onExport } = render();

		await act(async () => {
			button("Choose file…")?.dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});

		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({ defaultPath: "/tmp/proj/production.env" }),
		);
		expect(onExport).toHaveBeenCalledWith("/tmp/proj/production.env");
	});

	it("does nothing when the user cancels the save dialog", async () => {
		save.mockResolvedValue(null);
		const { onExport } = render();

		await act(async () => {
			button("Choose file…")?.dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});

		expect(onExport).not.toHaveBeenCalled();
	});

	it("refuses to export a bundle with nothing in it", () => {
		render({ count: 0 });
		expect(button("Choose file…")?.disabled).toBe(true);
		expect(container.textContent).toContain("No variables");
	});

	// The reason is shown here rather than pointed at: the variables list that
	// also carries it is behind this modal.
	it("shows the refusal reason inline and claims no file was written", async () => {
		save.mockResolvedValue("/tmp/proj/production.env");
		const reason =
			"Cannot export production: 1 variable(s) could not be decrypted (BAD). Nothing was written.";
		render({ onExport: vi.fn().mockResolvedValue(reason) });

		await act(async () => {
			button("Choose file…")?.dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});

		expect(container.textContent).toContain(reason);
		expect(container.textContent).not.toContain("Written to");
		expect(container.textContent).not.toContain("See the message in the list");
	});

	// Both dialogs open from the same settings section, so they must stack and
	// announce themselves the same way.
	it("is an announced dialog above the settings modal", () => {
		render();
		const dialog = container.querySelector('[role="dialog"]');
		expect(dialog?.getAttribute("aria-label")).toBe(
			"Export production to a .env file",
		);
		const backdrop = container.querySelector('[role="presentation"]');
		expect(backdrop).not.toBeNull();
	});

	// Escape belongs to the topmost overlay; the hook's stack supplies that.
	it("closes on Escape", () => {
		const onClose = vi.fn();
		render({ onClose });
		act(() => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
		});
		expect(onClose).toHaveBeenCalled();
	});
});
