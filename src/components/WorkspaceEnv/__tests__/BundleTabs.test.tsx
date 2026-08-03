import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvBundleMeta } from "../../../lib/ipc";
import { BundleTabs } from "../BundleTabs";

const bundle = (
	name: string,
	overrides: Partial<EnvBundleMeta> = {},
): EnvBundleMeta => ({
	id: `b-${name}`,
	workspaceId: "ws-1",
	name,
	injected: false,
	position: 0,
	varCount: 2,
	inherited: false,
	...overrides,
});

describe("BundleTabs injection toggle", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const handlers = {
		onSelect: vi.fn(),
		onCreate: vi.fn(),
		onRename: vi.fn(),
		onSetInjected: vi.fn(),
		onClearInjected: vi.fn(),
		onDelete: vi.fn(),
	};

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		vi.clearAllMocks();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	function render(bundles: EnvBundleMeta[], selected: string) {
		act(() => {
			root.render(
				<BundleTabs bundles={bundles} selected={selected} {...handlers} />,
			);
		});
	}

	const toggle = () =>
		container.querySelector<HTMLButtonElement>('button[role="switch"]');

	const click = (el: Element | null | undefined) =>
		act(() => {
			el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

	it("reads as on for the injected bundle and turns it off", () => {
		render([bundle("default", { injected: true })], "default");
		expect(toggle()?.getAttribute("aria-checked")).toBe("true");
		expect(toggle()?.textContent).toContain("Injected");

		click(toggle());
		expect(handlers.onClearInjected).toHaveBeenCalled();
		expect(handlers.onSetInjected).not.toHaveBeenCalled();
	});

	it("reads as off for an on-demand bundle and injects it", () => {
		render(
			[bundle("default", { injected: true }), bundle("production")],
			"production",
		);
		expect(toggle()?.getAttribute("aria-checked")).toBe("false");

		click(toggle());
		expect(handlers.onSetInjected).toHaveBeenCalledWith("production");
	});

	// Injection state is the toggle's job now — a per-tab badge would say the
	// same thing twice.
	it("carries no injection badge on the tabs themselves", () => {
		render([bundle("default", { injected: true })], "default");
		const tab = Array.from(container.querySelectorAll("button")).find(
			(b) => b.getAttribute("role") !== "switch",
		);
		expect(tab?.querySelector("svg")).toBeNull();
	});

	// `set_injected` resolves the bundle on THIS workspace, so a bundle that
	// exists only on the main worktree cannot be injected from here.
	it("offers no toggle for an inherited, non-injected bundle", () => {
		render(
			[
				bundle("default", { injected: true }),
				bundle("production", { inherited: true }),
			],
			"production",
		);
		expect(toggle()).toBeNull();
	});

	// A worktree CAN opt out of the environment it inherits.
	it("offers the toggle for an inherited bundle that is injected", () => {
		render([bundle("default", { injected: true, inherited: true })], "default");
		click(toggle());
		expect(handlers.onClearInjected).toHaveBeenCalled();
	});
});
