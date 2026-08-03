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
		clearInjected: vi.fn().mockResolvedValue(undefined),
		injectedSummary: vi.fn().mockResolvedValue(null),
		deleteBundle: vi.fn(),
		upsert: vi.fn(),
		upsertMany: vi.fn(),
		remove: vi.fn(),
		reveal: vi.fn(),
		reorder: vi.fn(),
		retryKey: vi.fn(),
	},
}));

import { env } from "../../../lib/ipc";
import { useWorkspaceEnvStore } from "../../../stores/workspaceEnvStore";
import { InjectedBundlePill } from "../InjectedBundlePill";

const WS = "ws-1";

/** Seed both the store and the IPC the mount-time refresh will fetch, so the
 *  refresh confirms the state rather than wiping it. */
function setSummary(
	summary: {
		bundle: string;
		varCount: number;
		inherited: boolean;
	} | null,
) {
	useWorkspaceEnvStore.setState({ injectedSummary: { [WS]: summary } });
	vi.mocked(env.injectedSummary).mockResolvedValue(summary);
}

describe("InjectedBundlePill", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		useWorkspaceEnvStore.setState({
			injectedSummary: {},
			dirtyInjected: new Set<string>(),
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.clearAllMocks();
	});

	function render() {
		act(() => {
			root.render(<InjectedBundlePill workspaceId={WS} />);
		});
	}

	const pill = () => container.querySelector("span[aria-label]");

	it("names the injected bundle and its variable count", () => {
		setSummary({ bundle: "production", varCount: 4, inherited: false });
		render();
		expect(pill()?.textContent).toContain("production");
		expect(pill()?.textContent).toContain("4");
	});

	it("renders nothing when injection is off", () => {
		setSummary(null);
		render();
		expect(pill()).toBeNull();
	});

	// An injected bundle with no variables puts nothing in the terminal, so a
	// badge claiming an environment would be a lie.
	it("renders nothing when the injected bundle is empty", () => {
		setSummary({ bundle: "default", varCount: 0, inherited: false });
		render();
		expect(pill()).toBeNull();
	});

	// The status bar reports; it does not act. Turning injection off lives on
	// the bundle row in workspace settings.
	it("is read-only — no controls in the status bar", () => {
		setSummary({ bundle: "production", varCount: 2, inherited: false });
		render();
		expect(container.querySelector("button")).toBeNull();
	});

	it("says so in the tooltip when the bundle is inherited", () => {
		setSummary({ bundle: "default", varCount: 1, inherited: true });
		render();
		expect(pill()?.getAttribute("title")).toContain(
			"inherited from the main worktree",
		);
	});
});
