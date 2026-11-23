import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	list: vi.fn(),
	connectSaved: vi.fn(),
	request: vi.fn(),
	openRemoteProfile: vi.fn(),
}));
vi.mock("../../lib/ipc", async (orig) => ({
	...(await orig<typeof import("../../lib/ipc")>()),
	hostsApi: api,
}));

import { OpenRemoteProfileDialog } from "../OpenRemoteProfileDialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe("OpenRemoteProfileDialog", () => {
	let root: ReturnType<typeof createRoot>;
	let container: HTMLDivElement;
	const onClose = vi.fn();

	beforeEach(async () => {
		vi.clearAllMocks();
		api.list.mockResolvedValue([
			{
				id: "box",
				name: "build-box",
				target: { kind: "ssh", destination: "box" },
			},
		]);
		api.connectSaved.mockResolvedValue(undefined);
		api.openRemoteProfile.mockResolvedValue("window-1");
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => root.render(<OpenRemoteProfileDialog onClose={onClose} />));
		await flush();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const connect = async () => {
		const button = [...document.querySelectorAll("button")].find(
			(b) => b.textContent === "Connect",
		);
		act(() => button?.click());
		await flush();
	};

	it("opens a Host's only Profile at once", async () => {
		api.request.mockResolvedValue([{ id: "p1", name: "Default" }]);
		await connect();
		expect(api.openRemoteProfile).toHaveBeenCalledWith("box", "p1", "Default");
		expect(onClose).toHaveBeenCalled();
	});

	it("lets the user choose among several", async () => {
		api.request.mockResolvedValue([
			{ id: "p1", name: "Default" },
			{ id: "p2", name: "Work" },
		]);
		await connect();
		expect(api.openRemoteProfile).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("Work");
	});
});
