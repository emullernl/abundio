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
		clearInjected: vi.fn(),
		deleteBundle: vi.fn(),
		upsert: vi.fn(),
		upsertMany: vi.fn(),
		remove: vi.fn(),
		reveal: vi.fn(),
		injectedSummary: vi.fn(),
		retryKey: vi.fn(),
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
	updatedAt: 0,
});

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
});
