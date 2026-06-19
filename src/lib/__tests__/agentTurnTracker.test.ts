import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProfileStore } from "../../stores/profileStore";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
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
	useWorkspaceGitStore.setState({ byWorkspaceId: {} });
	vi.spyOn(telemetry, "recordTurn").mockResolvedValue(undefined);
	vi.spyOn(git, "fetchBundle").mockResolvedValue({
		changedFiles: [],
		// biome-ignore lint/suspicious/noExplicitAny: minimal stub for the bundle
		branchInfo: {} as any,
		statusFingerprint: "",
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
	it("floors net-negative deltas at 0 but keeps the raw end snapshot", async () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("ws1", [{ paneId: "pane1", ptyId: "pty1" }])],
		});
		useWorkspaceGitStore.setState({
			byWorkspaceId: {
				ws1: {
					isGitRepo: true,
					currentBranch: "main",
					changedFileCount: 1,
					additions: 10,
					deletions: 5,
				},
			},
		});
		registerAgentPty("pty1", "pane1");
		// End snapshot smaller than start (a revert): net would be negative.
		(git.fetchBundle as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			changedFiles: [
				{
					path: "a",
					status: "M",
					additions: 5,
					deletions: 1,
					section: "unstaged",
				},
			],
			branchInfo: {},
			statusFingerprint: "",
		});
		noteState("pty1", "active");
		await noteState("pty1", "ready");
		const rec = lastRecord();
		expect(rec.linesAdded).toBe(0); // max(0, 5 - 10)
		expect(rec.gitAddedStart).toBe(10);
		expect(rec.gitAddedEnd).toBe(5);
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
		useWorkspaceGitStore.setState({
			byWorkspaceId: {
				ws1: {
					isGitRepo: true,
					currentBranch: "main",
					changedFileCount: 0,
					additions: 0,
					deletions: 0,
				},
			},
		});
		registerAgentPty("pty1", "pane1");
		registerAgentPty("pty2", "pane2");
		(git.fetchBundle as ReturnType<typeof vi.fn>).mockResolvedValue({
			changedFiles: [
				{
					path: "a",
					status: "M",
					additions: 8,
					deletions: 0,
					section: "unstaged",
				},
			],
			branchInfo: {},
			statusFingerprint: "",
		});
		noteState("pty1", "active");
		noteState("pty2", "active"); // overlap → both contaminated
		await noteState("pty1", "ready");
		await noteState("pty2", "ready");
		const calls = (telemetry.recordTurn as ReturnType<typeof vi.fn>).mock.calls;
		const recs = calls.map((c) => c[0] as AgentTurnRecord);
		expect(recs).toHaveLength(2);
		for (const r of recs) {
			expect(r.linesAdded).toBeNull();
			expect(r.linesDeleted).toBeNull();
			// Raw end snapshot still recorded for later re-derivation.
			expect(r.gitAddedEnd).toBe(8);
		}
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
