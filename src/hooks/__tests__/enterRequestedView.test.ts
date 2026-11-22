import { beforeEach, describe, expect, it, vi } from "vitest";

const takeView = vi.fn();
vi.mock("../../lib/ipc", async (orig) => ({
	...(await orig<typeof import("../../lib/ipc")>()),
	hostsApi: { takeView: () => takeView() },
}));

import { useWindowUiStore } from "../../stores/windowUiStore";
import { enterRequestedView } from "../useWorkspace";

describe("enterRequestedView (phase 10e: Open Orchestrator)", () => {
	beforeEach(() => {
		useWindowUiStore.setState({ orchestratorViewOpen: false });
	});

	it("puts the Orchestrator view on screen when the Window was opened for it", async () => {
		takeView.mockResolvedValueOnce("orchestrator");
		await enterRequestedView();
		expect(useWindowUiStore.getState().orchestratorViewOpen).toBe(true);
	});

	it("leaves the view alone otherwise", async () => {
		takeView.mockResolvedValueOnce(null);
		await enterRequestedView();
		expect(useWindowUiStore.getState().orchestratorViewOpen).toBe(false);
	});
});
