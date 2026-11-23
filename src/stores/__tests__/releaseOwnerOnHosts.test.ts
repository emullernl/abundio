import { beforeEach, describe, expect, it, vi } from "vitest";

const callOn = vi.fn(async () => 0);
vi.mock("../../lib/ipc", async (orig) => ({
	...(await orig<typeof import("../../lib/ipc")>()),
	joinedApi: { callOn: (...a: unknown[]) => callOn(...(a as [])) },
}));

import { releaseOwnerOnHosts, useJoinedStore } from "../joinedStore";

const entry = (hostId: string) => ({
	hostId,
	hostName: hostId,
	remoteProfileId: "p",
	remoteProfileName: "Default",
	lastSeenMs: null,
});

describe("releaseOwnerOnHosts (ADR-0065)", () => {
	beforeEach(() => callOn.mockClear());

	it("tells each connected joined Host that a local owner closed", () => {
		useJoinedStore.setState({
			entries: [entry("box"), entry("lab")],
			links: {
				box: { state: "online" },
				lab: { state: "offline", reason: "down", signIn: false },
			},
		});
		releaseOwnerOnHosts("pane-1");
		expect(callOn).toHaveBeenCalledTimes(1);
		expect(callOn).toHaveBeenCalledWith("box", "control_owner_gone", {
			owner: "pane-1",
		});
	});
});
