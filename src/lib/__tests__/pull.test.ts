import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchUpstream = vi.fn();
const pullFf = vi.fn();
vi.mock("../ipc", () => ({
	git: {
		fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
		pullFf: (...a: unknown[]) => pullFf(...a),
	},
}));
const hasWorkingAgent = vi.fn(() => false);
vi.mock("../../hooks/useConfirmCloseWorkspace", () => ({
	detectWorkForWorkspace: () => ({
		hasWorkingAgent: hasWorkingAgent(),
		hasRunningCommand: false,
	}),
}));

import { useIncomingStore } from "../../stores/incomingStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { checkIncoming, pullWorkspace } from "../pull";

beforeEach(() => {
	fetchUpstream.mockReset();
	pullFf.mockReset();
	hasWorkingAgent.mockReturnValue(false);
	useIncomingStore.setState({
		upstreamById: {},
		lastAttemptById: {},
		errorById: {},
		checking: new Set(),
		pulling: new Set(),
		dialog: null,
	});
	useWorkspaceStore.setState({
		workspaces: [{ id: "w1", rootFolder: "/repo", name: "Repo", tabs: [] }],
	} as never);
});

describe("checkIncoming", () => {
	it("remembers a failure for the tooltip, quietly", async () => {
		fetchUpstream.mockResolvedValue({ kind: "failed", message: "offline" });
		await checkIncoming("w1");
		expect(fetchUpstream).toHaveBeenCalledWith("/repo", false);
		const s = useIncomingStore.getState();
		expect(s.errorById.w1).toBe("offline");
		expect(s.lastAttemptById.w1).toBeGreaterThan(0);
		expect(s.checking.has("w1")).toBe(false);
		expect(s.dialog).toBeNull();
	});
	it("passes a background check on to Rust", async () => {
		fetchUpstream.mockResolvedValue({ kind: "skipped" });
		await checkIncoming("w1", { background: true });
		expect(fetchUpstream).toHaveBeenCalledWith("/repo", true);
		expect(useIncomingStore.getState().errorById.w1).toBeUndefined();
	});
	it("does not clear checking under a running Pull", async () => {
		useIncomingStore.setState({ pulling: new Set(["w1"]) });
		fetchUpstream.mockResolvedValue({ kind: "fetched" });
		await checkIncoming("w1");
		expect(useIncomingStore.getState().checking.has("w1")).toBe(true);
	});
	it("clears the failure on success", async () => {
		useIncomingStore.setState({ errorById: { w1: "offline" } });
		fetchUpstream.mockResolvedValue({ kind: "fetched" });
		await checkIncoming("w1");
		expect(useIncomingStore.getState().errorById.w1).toBeUndefined();
	});
});

describe("pullWorkspace", () => {
	it("asks first when an Agent is Working", async () => {
		hasWorkingAgent.mockReturnValue(true);
		await pullWorkspace("w1");
		expect(pullFf).not.toHaveBeenCalled();
		expect(useIncomingStore.getState().dialog).toEqual({
			kind: "confirmBusy",
			workspaceId: "w1",
		});
	});
	it("pulls once confirmed", async () => {
		hasWorkingAgent.mockReturnValue(true);
		pullFf.mockResolvedValue({ kind: "pulled", count: 1, upstream: "o/m" });
		await pullWorkspace("w1", { confirmed: true });
		expect(pullFf).toHaveBeenCalledWith("/repo");
		expect(useIncomingStore.getState().dialog).toBeNull();
		expect(useIncomingStore.getState().pulling.has("w1")).toBe(false);
		expect(useIncomingStore.getState().checking.has("w1")).toBe(false);
	});
	it("shows why a Pull was refused", async () => {
		const outcome = {
			kind: "refused",
			reason: "overlap",
			files: ["a.txt"],
			upstream: "o/m",
			outgoing: 0,
			incoming: 1,
		};
		pullFf.mockResolvedValue(outcome);
		await pullWorkspace("w1");
		expect(useIncomingStore.getState().dialog).toEqual({
			kind: "outcome",
			workspaceId: "w1",
			outcome,
		});
	});
	it("turns a thrown error into a failure dialog", async () => {
		pullFf.mockRejectedValue(new Error("boom"));
		await pullWorkspace("w1");
		expect(useIncomingStore.getState().dialog).toEqual({
			kind: "outcome",
			workspaceId: "w1",
			outcome: { kind: "failed", message: "boom" },
		});
	});
});
