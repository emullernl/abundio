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
		reorder: vi.fn(),
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
const variable = (name: string, position: number) => ({
	id: `v-${name}`,
	bundleId: "b-default",
	name,
	byteLen: 12,
	position,
	inherited: false,
	undecryptable: false,
	updatedAt: 0,
});

describe("EnvVarsSection", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
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
});
