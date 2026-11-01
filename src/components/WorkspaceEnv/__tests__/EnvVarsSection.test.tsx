import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../../lib/ipc", () => ({
	listen: vi.fn(() => Promise.resolve(() => {})),
	env: {
		list: vi.fn(),
		createBundle: vi.fn(),
		renameBundle: vi.fn(),
		setInjected: vi.fn(),
		clearInjected: vi.fn(),
		deleteBundle: vi.fn(),
		upsert: vi.fn(),
		upsertMany: vi.fn(),
		remove: vi.fn(),
		reveal: vi.fn(),
		injectedSummary: vi.fn(),
		retryKey: vi.fn(),
		exportToPath: vi.fn(),
	},
}));

import { useWorkspaceEnvStore } from "../../../stores/workspaceEnvStore";
import { EnvVarsSection } from "../EnvVarsSection";

const bundle = (name: string, injected: boolean) => ({
	id: `b-${name}`,
	workspaceId: "ws-1",
	name,
	injected,
	position: 0,
	varCount: 0,
	inherited: false,
});

/** `position` is deliberately the insertion order, not the display order. */
const variable = (name: string, position: number, inherited = false) => ({
	id: `v-${name}`,
	bundleId: "b-default",
	name,
	byteLen: 12,
	position,
	inherited,
	undecryptable: false,
	prefix: "abcd",
	updatedAt: 0,
});

/** The collapsed label of one row, by name. */
const rowLabel = (container: HTMLElement, name: string) =>
	Array.from(container.querySelectorAll("button[aria-expanded]")).find(
		(el) => el.querySelector("span")?.textContent === name,
	)?.textContent ?? "";

describe("EnvVarsSection", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	// The store is module-global; each test starts from the real initial state.
	const initialState = useWorkspaceEnvStore.getState();

	beforeEach(() => {
		useWorkspaceEnvStore.setState(initialState, true);
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

	function renderSection() {
		act(() => {
			root.render(
				<EnvVarsSection
					workspaceId="ws-1"
					inheritFromWorkspaceId={null}
					workspaceFolder="/tmp/ws"
					workspaceName="proj"
					liveTerminalCount={0}
					onApplyToRunning={() => {}}
					onShowUsage={() => {}}
				/>,
			);
		});
	}

	/** Row names, in DOM order. */
	const names = () =>
		Array.from(container.querySelectorAll("button[aria-expanded]")).map(
			(el) => el.querySelector("span")?.textContent ?? "",
		);

	it("renders variables alphabetically, not in insertion order", () => {
		useWorkspaceEnvStore.setState({
			bundles: [bundle("default", true)],
			selectedBundle: "default",
			vars: [
				variable("ZED_TOKEN", 0),
				variable("API_KEY", 1),
				variable("database_url", 2),
				variable("MAX_RETRIES", 3),
			],
		});
		renderSection();

		expect(names()).toEqual([
			"API_KEY",
			"database_url",
			"MAX_RETRIES",
			"ZED_TOKEN",
		]);
	});

	// The backend hands over inherited rows first, then own ones. Display
	// interleaves them — the INHERITED badge carries the distinction.
	it("interleaves inherited variables into the same alphabetical run", () => {
		useWorkspaceEnvStore.setState({
			bundles: [bundle("default", true)],
			selectedBundle: "default",
			vars: [
				variable("SHARED_TOKEN", 0, true),
				variable("ZONE", 1, true),
				variable("API_KEY", 0),
				variable("TIMEOUT", 1),
			],
		});
		renderSection();

		expect(names()).toEqual(["API_KEY", "SHARED_TOKEN", "TIMEOUT", "ZONE"]);
	});

	// Numbered names are common enough that codepoint order (PORT_10 < PORT_2)
	// is a visible wrong answer.
	it("orders numeric suffixes by value", () => {
		useWorkspaceEnvStore.setState({
			bundles: [bundle("default", true)],
			selectedBundle: "default",
			vars: [variable("PORT_10", 0), variable("PORT_2", 1)],
		});
		renderSection();

		expect(names()).toEqual(["PORT_2", "PORT_10"]);
	});

	// `sensitivity: "base"` makes these compare equal, so the order falls back
	// to Array.sort stability — i.e. storage order. Recorded, not relied on.
	it("keeps storage order for names differing only by case", () => {
		useWorkspaceEnvStore.setState({
			bundles: [bundle("default", true)],
			selectedBundle: "default",
			vars: [variable("path", 0), variable("PATH", 1)],
		});
		renderSection();

		expect(names()).toEqual(["path", "PATH"]);
	});

	describe("empty values", () => {
		it("renders (empty) instead of dots and a size", () => {
			useWorkspaceEnvStore.setState({
				bundles: [bundle("default", true)],
				selectedBundle: "default",
				vars: [{ ...variable("EMPTY", 0), byteLen: 0, prefix: null }],
			});
			renderSection();

			expect(rowLabel(container, "EMPTY")).toContain("(empty)");
			expect(rowLabel(container, "EMPTY")).not.toContain("••••");
			expect(rowLabel(container, "EMPTY")).not.toContain("0 B");
		});

		it("lets the add form submit a variable with no value", () => {
			const upsert = vi.fn().mockResolvedValue(undefined);
			useWorkspaceEnvStore.setState({
				bundles: [bundle("default", true)],
				selectedBundle: "default",
				vars: [],
				upsert: upsert as never,
			});
			renderSection();

			const nameInput = container.querySelector<HTMLInputElement>(
				'input[placeholder="NAME"]',
			);
			const valueInput = container.querySelector<HTMLTextAreaElement>(
				'textarea[placeholder="value"]',
			);
			// React tracks the DOM value itself, so a plain `.value =` assignment
			// is ignored. Go through the native setter it installed.
			const setNativeValue = (
				el: HTMLInputElement | HTMLTextAreaElement,
				value: string,
			) => {
				const proto =
					el instanceof HTMLTextAreaElement
						? HTMLTextAreaElement.prototype
						: HTMLInputElement.prototype;
				Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
				el.dispatchEvent(new Event("input", { bubbles: true }));
			};
			act(() => {
				if (nameInput) setNativeValue(nameInput, "EMPTY_FLAG");
				if (valueInput) setNativeValue(valueInput, "");
			});

			const addButton = Array.from(
				container.querySelectorAll<HTMLButtonElement>("button"),
			).find((el) => el.textContent === "Add");
			expect(addButton?.disabled).toBe(false);

			act(() => {
				addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			expect(upsert).toHaveBeenCalledWith(
				"ws-1",
				null,
				"default",
				"EMPTY_FLAG",
				"",
			);
		});
	});

	describe("prefix peek", () => {
		it("shows the four-character prefix in front of the mask", () => {
			useWorkspaceEnvStore.setState({
				bundles: [bundle("default", true)],
				selectedBundle: "default",
				vars: [variable("TOKEN", 0)],
			});
			renderSection();

			expect(rowLabel(container, "TOKEN")).toContain("abcd••••");
		});

		it("shows plain dots when the backend has no safe prefix", () => {
			useWorkspaceEnvStore.setState({
				bundles: [bundle("default", true)],
				selectedBundle: "default",
				vars: [{ ...variable("SHORT", 0), prefix: null }],
			});
			renderSection();

			expect(rowLabel(container, "SHORT")).not.toContain("abcd");
			expect(rowLabel(container, "SHORT")).toContain("••••");
		});

		// An unreadable row must not claim a prefix it could not read.
		it("says unreadable rather than showing a prefix", () => {
			useWorkspaceEnvStore.setState({
				bundles: [bundle("default", true)],
				selectedBundle: "default",
				vars: [{ ...variable("LOST", 0), undecryptable: true, prefix: null }],
			});
			renderSection();

			expect(rowLabel(container, "LOST")).toContain("unreadable");
		});
	});
});
