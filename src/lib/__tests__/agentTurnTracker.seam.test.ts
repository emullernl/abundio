// Status-seam integration tests: drive the REAL ptyActivityStore actions through
// the status reducer and the StatusChange seam into the turn tracker (the
// noteState-level tests in agentTurnTracker.test.ts bypass this wiring).
//
// Regression: a command-detected Agent whose TUI floods output (e.g. Copilot)
// trips the activity byte-heuristic into Working BEFORE its first hook. The
// first `userPromptSubmitted` then only flips `hookDriven` (Working→Working);
// the seam still emits it, but the tracker must not drop it on the
// equal-state guard — otherwise the Turn never opens and nothing records.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProfileStore } from "../../stores/profileStore";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	__openTurnCountForTests,
	__resetAgentTurnTrackerForTests,
	initAgentTurnTracker,
} from "../agentTurnTracker";
import { type AgentTurnRecord, git, telemetry } from "../ipc";
import type { WorkspaceWithTabs } from "../types";

const PROFILE = "p1";

function makeWorkspace(
	id: string,
	paneId: string,
	ptyId: string,
): WorkspaceWithTabs {
	return {
		id,
		name: id,
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
				id: `${id}-t`,
				workspaceId: id,
				name: "T",
				layoutJson: JSON.stringify({ type: "terminal", id: paneId, ptyId }),
				position: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		],
	};
}

/** Register an agent-mode PTY with a chosen starting dot-state and hookDriven. */
function register(
	ptyId: string,
	paneId: string,
	agentId: string,
	state: "idle" | "active",
	hookDriven: boolean,
) {
	usePtyActivityStore.setState((s) => ({
		panePtyMap: { ...s.panePtyMap, [paneId]: ptyId },
		detectedAgentIds: { ...s.detectedAgentIds, [ptyId]: agentId },
		activities: {
			...s.activities,
			[ptyId]: {
				state,
				lastOutputAt: null,
				hasEverReceivedOutput: true,
				detectionMode: "agent",
				hookDriven,
			},
		},
	}));
}

beforeEach(() => {
	__resetAgentTurnTrackerForTests();
	useProfileStore.setState({ activeProfileId: PROFILE });
	usePtyActivityStore.setState({
		panePtyMap: {},
		detectedAgentIds: {},
		activities: {},
		cwds: {},
	});
	vi.spyOn(telemetry, "recordTurn").mockResolvedValue(undefined);
	vi.spyOn(git, "snapshotWorktree").mockResolvedValue("oid");
	vi.spyOn(git, "diffTrees").mockResolvedValue({
		additions: 0,
		deletions: 0,
		files: 0,
	});
	initAgentTurnTracker();
});

describe("turn tracker via the StatusChange seam", () => {
	it("opens a Turn when the active hook is a real Idle→Working transition", () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsC", "paneC", "ptyC")],
		});
		register("ptyC", "paneC", "claude", "idle", false);
		usePtyActivityStore.getState().applyHookEvent("ptyC", "active");
		expect(__openTurnCountForTests()).toBe(1);
	});

	it("opens a Turn when the first hook lands while already Working (Copilot TUI-flood regression)", () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsK", "paneK", "ptyK")],
		});
		// Command-detected, not yet hookDriven, byte-heuristic already at Working.
		register("ptyK", "paneK", "copilot", "active", false);
		usePtyActivityStore.getState().applyHookEvent("ptyK", "active"); // userPromptSubmitted
		expect(__openTurnCountForTests()).toBe(1);
	});

	it("records the full Turn for the already-Working case (active → ready)", async () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsK", "paneK", "ptyK")],
		});
		register("ptyK", "paneK", "copilot", "active", false);
		const a = usePtyActivityStore.getState();
		a.applyHookEvent("ptyK", "active"); // userPromptSubmitted (Working→Working)
		a.applyHookEvent("ptyK", "ready"); // agentStop
		await vi.waitFor(() =>
			expect(
				(telemetry.recordTurn as ReturnType<typeof vi.fn>).mock.calls.length,
			).toBe(1),
		);
		const rec = (telemetry.recordTurn as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as AgentTurnRecord;
		expect(rec.agentId).toBe("copilot");
		expect(rec.endReason).toBe("stop");
	});

	it("does NOT open a Turn on a mode-only change (agentDetected, state unchanged)", () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsM", "paneM", "ptyM")],
		});
		// Shell-mode PTY sitting idle; detecting the agent flips mode only.
		usePtyActivityStore.setState((s) => ({
			panePtyMap: { ...s.panePtyMap, paneM: "ptyM" },
			activities: {
				...s.activities,
				ptyM: {
					state: "idle",
					lastOutputAt: null,
					hasEverReceivedOutput: true,
					detectionMode: "shell",
					hookDriven: false,
				},
			},
		}));
		usePtyActivityStore.getState().setAgentPty("ptyM", "copilot");
		expect(__openTurnCountForTests()).toBe(0);
	});
});
