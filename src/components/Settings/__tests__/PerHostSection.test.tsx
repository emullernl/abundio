import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/ipc", () => ({
	hostsApi: { list: () => Promise.resolve([]) },
	joinedApi: {
		attach: () => Promise.resolve(),
		callOn: () => Promise.resolve(null),
	},
	listenToThisWindow: () => Promise.resolve(() => {}),
	shells: { listAvailable: () => Promise.resolve([]) },
}));

import { useSettingsHostStore } from "../../../stores/settingsHostStore";
import { PerHostSection } from "../PerHostSection";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

const render = () =>
	act(() =>
		root.render(<PerHostSection local={<p>mine</p>} host={<p>theirs</p>} />),
	);

describe("PerHostSection (ADR-0064)", () => {
	it("shows this computer's section with no Host picked", () => {
		useSettingsHostStore.setState({ hostId: null });
		render();
		expect(container.textContent).toBe("mine");
	});
	it("asks to connect before showing a Host's, never a stale copy", () => {
		useSettingsHostStore.setState({
			hostId: "box",
			hostName: "Build box",
			link: { state: "offline", reason: "Permission denied" },
		});
		render();
		expect(container.textContent).toContain("Not connected to Build box.");
		expect(container.textContent).toContain("Connect to edit");
		expect(container.textContent).not.toContain("theirs");
	});
	it("shows the Host's once connected", () => {
		useSettingsHostStore.setState({
			hostId: "box",
			hostName: "Build box",
			link: { state: "ready" },
		});
		render();
		expect(container.textContent).toContain("theirs");
		expect(container.textContent).toContain("Build box");
	});
});
