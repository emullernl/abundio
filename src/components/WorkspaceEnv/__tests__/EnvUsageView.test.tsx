import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../../lib/ipc", () => ({
	env: {
		list: vi.fn(),
		createBundle: vi.fn(),
		renameBundle: vi.fn(),
		setInjected: vi.fn(),
		deleteBundle: vi.fn(),
		upsert: vi.fn(),
		upsertMany: vi.fn(),
		remove: vi.fn(),
		reveal: vi.fn(),
		reorder: vi.fn(),
		retryKey: vi.fn(),
	},
}));

import { useWorkspaceEnvStore } from "../../../stores/workspaceEnvStore";
import { EnvUsageView } from "../EnvUsageView";

const bundle = (name: string, injected: boolean) => ({
	id: `b-${name}`,
	workspaceId: "ws-1",
	name,
	injected,
	position: 0,
	varCount: 0,
	inherited: false,
});

describe("EnvUsageView", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		useWorkspaceEnvStore.setState({
			bundles: [bundle("default", true), bundle("production", false)],
			selectedBundle: "default",
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	function renderTab() {
		act(() => {
			root.render(<EnvUsageView />);
		});
	}

	const commands = () =>
		Array.from(container.querySelectorAll("code")).map(
			(el) => el.textContent ?? "",
		);

	it("shows the run, print and list reference", () => {
		renderTab();
		const all = commands();
		expect(all).toContain("abundio-env run <bundle> -- <command>");
		expect(all).toContain("abundio-env print <bundle>");
		expect(all).toContain("abundio-env list");
	});

	it("covers compose, node, package scripts, subshell and inspection", () => {
		renderTab();
		const all = commands();
		expect(all).toContain("abundio-env run default -- docker compose up");
		expect(all).toContain("abundio-env run default -- node server.js");
		expect(all).toContain("abundio-env run default -- pnpm dev");
		expect(all).toContain("abundio-env run default -- $SHELL");
		expect(all).toContain("cat <(abundio-env print default)");
	});

	// Every command must be copy-paste ready, not a template to hand-edit.
	it("retargets every recipe when another bundle is picked", () => {
		renderTab();
		const productionPill = Array.from(
			container.querySelectorAll("button"),
		).find((b) => b.textContent?.trim() === "production");
		expect(productionPill).toBeDefined();

		act(() => {
			productionPill?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		// Exclude the quick-reference row, which is a signature with a
		// `<bundle>` placeholder rather than a runnable recipe.
		const recipes = commands().filter(
			(c) => c.startsWith("abundio-env run ") && !c.includes("<bundle>"),
		);
		expect(recipes.length).toBeGreaterThan(0);
		for (const command of recipes) {
			expect(command).toContain("production");
			expect(command).not.toContain("default");
		}
	});

	it("describes an injected bundle differently from an on-demand one", () => {
		renderTab();
		expect(container.textContent).toMatch(/already in every terminal/i);

		act(() => {
			Array.from(container.querySelectorAll("button"))
				.find((b) => b.textContent?.trim() === "production")
				?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(container.textContent).toMatch(/on-demand/i);
	});

	// Both of these fail silently or cost something, so the tab has to say so.
	it("warns about --env-file, scrollback and writing to a file", () => {
		renderTab();
		expect(container.textContent).toContain("--env-file");
		expect(container.textContent).toMatch(/scrollback/i);
		expect(container.textContent).toMatch(/plain text/i);
	});

	it("falls back to a single pill when bundles have not loaded", () => {
		useWorkspaceEnvStore.setState({ bundles: [], selectedBundle: "default" });
		renderTab();
		expect(commands()).toContain(
			"abundio-env run default -- docker compose up",
		);
	});
});
