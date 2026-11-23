import { describe, expect, it } from "vitest";
import { type HostLink, isNotConnectedError, nextLink } from "../hostLinkStore";

const online: HostLink = { state: "online" };

describe("nextLink", () => {
	it("goes offline when the connection ends and counts down each retry", () => {
		const lost = nextLink(online, { kind: "lost", reason: "eof" });
		expect(lost).toEqual({
			state: "offline",
			signIn: false,
			reason: "eof",
			retryAt: null,
		});
		const retrying = nextLink(lost, {
			kind: "retrying",
			reason: "timed out",
			signIn: false,
			retryInMs: 4000,
			now: 1000,
		});
		expect(retrying).toEqual({
			state: "offline",
			signIn: false,
			reason: "timed out",
			retryAt: 5000,
		});
	});

	it("stops counting when the Host needs the user to sign in", () => {
		const link = nextLink(online, {
			kind: "retrying",
			reason: "Permission denied",
			signIn: true,
			retryInMs: null,
			now: 1000,
		});
		expect(link).toMatchObject({ signIn: true, retryAt: null });
		// A failed Sign in (cancelled, say) still needs one.
		expect(
			nextLink(link, { kind: "failed", reason: "cancelled", signIn: false }),
		).toMatchObject({ signIn: true, reason: "cancelled" });
	});

	it("is back online once connected, or waits to reload with unsaved edits", () => {
		const off = nextLink(online, { kind: "lost", reason: null });
		expect(nextLink(off, { kind: "connected", caughtUp: true })).toEqual(
			online,
		);
		expect(nextLink(off, { kind: "connected", caughtUp: false })).toEqual({
			state: "back",
		});
	});
});

describe("isNotConnectedError", () => {
	it("knows Rust's not-connected error", () => {
		expect(
			isNotConnectedError("Channel error: not connected to 08963652-6511"),
		).toBe(true);
		expect(isNotConnectedError(new Error("Folder not found: /x"))).toBe(false);
	});
});
