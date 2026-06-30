import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProfileStore } from "../../stores/profileStore";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	__openTurnCountForTests,
	__resetAgentTurnTrackerForTests,
	finalizeAllOpenTurns,
	noteState,
	onPtyExit,
	onSessionEnd,
} from "../agentTurnTracker";
import { type AgentTurnRecord, git, telemetry } from "../ipc";
import type { WorkspaceWithTabs } from "../types";

const PROFILE = "profile-1";

function makeWorkspace(
	id: string,
	paneTerminals: { paneId: string; ptyId: string }[],
): WorkspaceWithTabs {
	const layout =
		paneTerminals.length === 1
			? {
					type: "terminal",
					id: paneTerminals[0].paneId,
					ptyId: paneTerminals[0].ptyId,
				}
			: {
					type: "split",
					id: `${id}-split`,
					direction: "horizontal",
					ratio: 0.5,
					first: {
						type: "terminal",
						id: paneTerminals[0].paneId,
						ptyId: paneTerminals[0].ptyId,
					},
					second: {
						type: "terminal",
						id: paneTerminals[1].paneId,
						ptyId: paneTerminals[1].ptyId,
					},
				};
	return {
		id,
		name: `WS ${id}`,
		rootFolder: `/tmp/${id}`,
		envJson: "{}",
		agentPresetsJson: "[]",
		fileTabsJson: "{}",
		baseBranch: "main",
		lastBranch: null,
		position: 0,
		profileId: PROFILE,
		createdAt: 0,
		updatedAt: 0,
		worktreeSetupCommands: "",
		tabs: [
			{
				id: `${id}-tab`,
				workspaceId: id,
				name: "Terminal 1",
				layoutJson: JSON.stringify(layout),
				position: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		],
	};
}

/** Register an agent-mode PTY bound to a pane, and (optionally) its workspace. */
function registerAgentPty(ptyId: string, paneId: string, agentId = "claude") {
	usePtyActivityStore.setState((s) => ({
		panePtyMap: { ...s.panePtyMap, [paneId]: ptyId },
		detectedAgentIds: { ...s.detectedAgentIds, [ptyId]: agentId },
		activities: {
			...s.activities,
			[ptyId]: {
				state: "idle",
				lastOutputAt: null,
				hasEverReceivedOutput: true,
				detectionMode: "agent",
				hookDriven: true,
			},
		},
	}));
}

function lastRecord(): AgentTurnRecord {
	const calls = (telemetry.recordTurn as ReturnType<typeof vi.fn>).mock.calls;
	return calls[calls.length - 1][0] as AgentTurnRecord;
}

beforeEach(() => {
	__resetAgentTurnTrackerForTests();
	useProfileStore.setState({ activeProfileId: PROFILE });
	useWorkspaceStore.setState({ workspaces: [] });
	usePtyActivityStore.setState({
		panePtyMap: {},
		detectedAgentIds: {},
		activities: {},
		cwds: {},
	});
	vi.spyOn(telemetry, "recordTurn").mockResolvedValue(undefined);
	// Per-Turn worktree snapshot/diff (ADR-0021): default to a no-op diff so
	// timing/session tests resolve cleanly; attribution tests override these.
	vi.spyOn(git, "snapshotWorktree").mockResolvedValue("oid");
	vi.spyOn(git, "diffTrees").mockResolvedValue({
		additions: 0,
		deletions: 0,
		files: 0,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("agentTurnTracker state machine", () => {
	it("opens exactly one turn on active, doesn't double-open, resumes after waiting", () => {
		registerAgentPty("pty1", "pane1");
		noteState("pty1", "active");
		expect(__openTurnCountForTests()).toBe(1);
		noteState("pty1", "active");
		expect(__openTurnCountForTests()).toBe(1);
		noteState("pty1", "waiting");
		noteState("pty1", "active");
		expect(__openTurnCountForTests()).toBe(1);
	});

	it("accrues working_ms and waiting_ms to the right states; working+waiting ≤ duration", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		registerAgentPty("pty1", "pane1");
		noteState("pty1", "active"); // working starts at 0
		vi.setSystemTime(1000);
		noteState("pty1", "waiting"); // working 0–1000 = 1000
		vi.setSystemTime(1500);
		noteState("pty1", "active"); // waiting 1000–1500 = 500
		vi.setSystemTime(2000);
		await noteState("pty1", "ready"); // working 1500–2000 = 500 → total 1500
		const rec = lastRecord();
		expect(rec.workingMs).toBe(1500);
		expect(rec.waitingMs).toBe(500);
		expect(rec.durationMs).toBe(2000);
		expect((rec.workingMs ?? 0) + (rec.waitingMs ?? 0)).toBeLessThanOrEqual(
			rec.durationMs ?? 0,
		);
	});

	it("counts permission requests and errors", async () => {
		registerAgentPty("pty1", "pane1");
		noteState("pty1", "active");
		noteState("pty1", "waiting"); // permission +1
		noteState("pty1", "active");
		await noteState("pty1", "error"); // error +1, finalize
		const rec = lastRecord();
		expect(rec.permissionRequestsCount).toBe(1);
		expect(rec.errorCount).toBe(1);
		expect(rec.endReason).toBe("error");
	});

	it("maps end reasons: ready→stop, error→error, session-end, pty-exit; records once each", async () => {
		registerAgentPty("pty1", "pane1");
		noteState("pty1", "active");
		await noteState("pty1", "ready");
		expect(lastRecord().endReason).toBe("stop");

		noteState("pty1", "active");
		await onSessionEnd("pty1");
		expect(lastRecord().endReason).toBe("session_end");

		noteState("pty1", "active");
		await onPtyExit("pty1");
		expect(lastRecord().endReason).toBe("pty_exit");

		expect(
			(telemetry.recordTurn as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBe(3);
	});
});

describe("agentTurnTracker git attribution", () => {
	it("records per-turn working-tree churn — deletions count, no flooring", async () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("ws1", [{ paneId: "pane1", ptyId: "pty1" }])],
		});
		registerAgentPty("pty1", "pane1");
		// Begin snapshot → "start", finalize snapshot → "end".
		(git.snapshotWorktree as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce("start")
			.mockResolvedValueOnce("end");
		// A revert: 0 added, 5 removed. The old net-vs-base metric floored this
		// to +0 −0; the working-tree diff records the real deletions.
		(git.diffTrees as ReturnType<typeof vi.fn>).mockResolvedValue({
			additions: 0,
			deletions: 5,
			files: 1,
		});
		noteState("pty1", "active");
		await noteState("pty1", "ready");
		const rec = lastRecord();
		expect(rec.linesAdded).toBe(0);
		expect(rec.linesDeleted).toBe(5);
		expect(rec.filesChanged).toBe(1);
		expect(git.diffTrees).toHaveBeenCalledWith("/tmp/ws1", "start", "end");
		// vs-base provenance columns are retired with the net-vs-base metric.
		expect(rec.gitAddedStart).toBeNull();
		expect(rec.gitAddedEnd).toBeNull();
	});

	it("nulls out line attribution when two turns overlap in one workspace", async () => {
		useWorkspaceStore.setState({
			workspaces: [
				makeWorkspace("ws1", [
					{ paneId: "pane1", ptyId: "pty1" },
					{ paneId: "pane2", ptyId: "pty2" },
				]),
			],
		});
		registerAgentPty("pty1", "pane1");
		registerAgentPty("pty2", "pane2");
		(git.diffTrees as ReturnType<typeof vi.fn>).mockResolvedValue({
			additions: 8,
			deletions: 0,
			files: 1,
		});
		noteState("pty1", "active");
		noteState("pty2", "active"); // overlap → both contaminated
		await noteState("pty1", "ready");
		await noteState("pty2", "ready");
		const calls = (telemetry.recordTurn as ReturnType<typeof vi.fn>).mock.calls;
		const recs = calls.map((c) => c[0] as AgentTurnRecord);
		expect(recs).toHaveLength(2);
		// Contaminated turns skip the diff entirely — line counts stay NULL.
		expect(git.diffTrees).not.toHaveBeenCalled();
		for (const r of recs) {
			expect(r.linesAdded).toBeNull();
			expect(r.linesDeleted).toBeNull();
			expect(r.gitAddedEnd).toBeNull();
		}
	});

	it("awaits a begin snapshot that resolves after the turn finalizes (fast-turn race)", async () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("ws1", [{ paneId: "pane1", ptyId: "pty1" }])],
		});
		registerAgentPty("pty1", "pane1");
		// The begin snapshot stays pending past noteState("ready") — the exact
		// race the `await t.startTreePromise` in writeRecord exists to handle.
		let resolveStart!: (oid: string) => void;
		const pendingStart = new Promise<string>((r) => {
			resolveStart = r;
		});
		(git.snapshotWorktree as ReturnType<typeof vi.fn>)
			.mockReturnValueOnce(pendingStart) // begin — pending
			.mockResolvedValueOnce("end"); // finalize
		(git.diffTrees as ReturnType<typeof vi.fn>).mockResolvedValue({
			additions: 3,
			deletions: 0,
			files: 1,
		});
		noteState("pty1", "active");
		const finalizing = noteState("pty1", "ready"); // now blocked on pendingStart
		resolveStart("start"); // begin snapshot resolves only after finalize began
		await finalizing;
		const rec = lastRecord();
		expect(rec.linesAdded).toBe(3);
		expect(git.diffTrees).toHaveBeenCalledWith("/tmp/ws1", "start", "end");
	});

	it("leaves line counts NULL when the start snapshot is unavailable (non-git)", async () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("ws1", [{ paneId: "pane1", ptyId: "pty1" }])],
		});
		registerAgentPty("pty1", "pane1");
		(git.snapshotWorktree as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		noteState("pty1", "active");
		await noteState("pty1", "ready");
		const rec = lastRecord();
		expect(rec.linesAdded).toBeNull();
		expect(rec.linesDeleted).toBeNull();
		expect(rec.filesChanged).toBeNull();
		// No start OID → the diff is never attempted.
		expect(git.diffTrees).not.toHaveBeenCalled();
	});

	it("leaves line counts NULL when the snapshot/diff throws", async () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("ws1", [{ paneId: "pane1", ptyId: "pty1" }])],
		});
		registerAgentPty("pty1", "pane1");
		// Begin/finalize snapshots succeed (default "oid" stub); the diff fails.
		(git.diffTrees as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("diff failed"),
		);
		noteState("pty1", "active");
		await noteState("pty1", "ready");
		const rec = lastRecord();
		expect(rec.linesAdded).toBeNull();
		expect(rec.linesDeleted).toBeNull();
		expect(rec.filesChanged).toBeNull();
	});
});

describe("agentTurnTracker sessions & bulk finalize", () => {
	it("shares a session id across a session's turns and starts a new one after session end", async () => {
		registerAgentPty("pty1", "pane1");
		noteState("pty1", "active");
		await noteState("pty1", "ready");
		const s1 = lastRecord().sessionId;
		noteState("pty1", "active");
		await noteState("pty1", "ready");
		const s2 = lastRecord().sessionId;
		expect(s2).toBe(s1);

		await onSessionEnd("pty1"); // no open turn, just ends the session
		noteState("pty1", "active");
		await noteState("pty1", "ready");
		const s3 = lastRecord().sessionId;
		expect(s3).not.toBe(s1);
	});

	it("finalizeAllOpenTurns flushes every open turn exactly once", async () => {
		registerAgentPty("pty1", "pane1");
		registerAgentPty("pty2", "pane2");
		noteState("pty1", "active");
		noteState("pty2", "active");
		expect(__openTurnCountForTests()).toBe(2);
		await finalizeAllOpenTurns("app_quit");
		expect(__openTurnCountForTests()).toBe(0);
		const calls = (telemetry.recordTurn as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls).toHaveLength(2);
		expect(
			calls.every((c) => (c[0] as AgentTurnRecord).endReason === "app_quit"),
		).toBe(true);
	});

	it("ignores non-agent ptys (no open turn created)", () => {
		// No registerAgentPty → detectedAgentIds has no entry.
		noteState("ptyX", "active");
		expect(__openTurnCountForTests()).toBe(0);
	});
});
