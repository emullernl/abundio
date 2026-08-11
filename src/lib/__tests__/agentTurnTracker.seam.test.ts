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
import {
	__emitStatusChangeForTests,
	touchLastOutput,
	usePtyActivityStore,
} from "../../stores/ptyActivityStore";
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
		agentPtyIds: new Set(),
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
		usePtyActivityStore.getState().applyHookEvent("ptyC", "active", true);
		expect(__openTurnCountForTests()).toBe(1);
	});

	it("opens a Turn when the first hook lands while already Working (Copilot TUI-flood regression)", () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsK", "paneK", "ptyK")],
		});
		// Command-detected, not yet hookDriven, byte-heuristic already at Working.
		register("ptyK", "paneK", "copilot", "active", false);
		usePtyActivityStore.getState().applyHookEvent("ptyK", "active", true); // userPromptSubmitted
		expect(__openTurnCountForTests()).toBe(1);
	});

	it("records the full Turn for the already-Working case (active → ready)", async () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsK", "paneK", "ptyK")],
		});
		register("ptyK", "paneK", "copilot", "active", false);
		const a = usePtyActivityStore.getState();
		a.applyHookEvent("ptyK", "active", true); // userPromptSubmitted (Working→Working)
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

	it("records an auto-launched Agent: setAgentPty(no id) → command/hook backfills the id → Turn records", async () => {
		// Reproduces the workspace-load auto-launch path. The pane is marked an
		// agent WITHOUT an id first (terminalManager `takePendingAgent`); the id
		// only arrives later from a `command_start` title match or the first hook,
		// which used to early-return and drop it — leaving detectedAgentIds empty
		// (terminal icon, no Turns).
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsA", "paneA", "ptyA")],
		});
		usePtyActivityStore.setState((s) => ({
			panePtyMap: { ...s.panePtyMap, paneA: "ptyA" },
			activities: {
				...s.activities,
				ptyA: {
					state: "idle",
					lastOutputAt: null,
					hasEverReceivedOutput: true,
					detectionMode: "shell",
					hookDriven: false,
				},
			},
		}));
		const a = usePtyActivityStore.getState();
		a.setAgentPty("ptyA"); // (1) auto-launch: agent mode, no id
		a.recordOutput("ptyA"); // (2) TUI flood → Working
		a.setAgentPty("ptyA", "copilot"); // (3) command_start match → backfills id
		// The id must now be recorded (drives both the titlebar icon and the tracker).
		expect(usePtyActivityStore.getState().detectedAgentIds.ptyA).toBe(
			"copilot",
		);
		a.applyHookEvent("ptyA", "active", true); // (4) userPromptSubmitted (Working→Working)
		a.applyHookEvent("ptyA", "ready"); // (5) agentStop
		await vi.waitFor(() =>
			expect(
				(telemetry.recordTurn as ReturnType<typeof vi.fn>).mock.calls.length,
			).toBe(1),
		);
		const rec = (telemetry.recordTurn as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as AgentTurnRecord;
		expect(rec.agentId).toBe("copilot");
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

describe("mid-turn failure does not split a Turn (ADR-0026)", () => {
	// recordTurn is spied per-test but its call list is cumulative across this
	// file, so clear it here and assert on this test's calls alone.
	const recorded = () =>
		(telemetry.recordTurn as ReturnType<typeof vi.fn>).mock
			.calls as unknown as [AgentTurnRecord][];

	beforeEach(() => {
		(telemetry.recordTurn as ReturnType<typeof vi.fn>).mockClear();
	});

	it("keeps one Turn across errorOccurred → acknowledge → agentStop", async () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsM", "paneM", "ptyM")],
		});
		register("ptyM", "paneM", "copilot", "idle", false);
		const a = usePtyActivityStore.getState();
		a.applyHookEvent("ptyM", "active", true); // userPromptSubmitted
		expect(__openTurnCountForTests()).toBe(1);

		a.applyHookEvent("ptyM", "errorMidTurn"); // errorOccurred, agent keeps going
		expect(__openTurnCountForTests()).toBe(1); // NOT finalized

		// The user acknowledges the red icon. Without the errorMidTurn guard this
		// error → active would open a second Turn, started at click time.
		a.clearError("ptyM");
		expect(__openTurnCountForTests()).toBe(1);

		a.applyHookEvent("ptyM", "ready"); // agentStop
		await vi.waitFor(() => expect(recorded().length).toBe(1));
		const rec = recorded()[0][0];
		// One row, ended cleanly, with the failure counted against it.
		expect(rec.endReason).toBe("stop");
		expect(rec.errorCount).toBe(1);
	});

	it("a Turn failure still finalizes the Turn as an error", async () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsT", "paneT", "ptyT")],
		});
		register("ptyT", "paneT", "claude", "idle", false);
		const a = usePtyActivityStore.getState();
		a.applyHookEvent("ptyT", "active", true);
		a.applyHookEvent("ptyT", "error"); // StopFailure
		await vi.waitFor(() => expect(recorded().length).toBe(1));
		const rec = recorded()[0][0];
		expect(rec.endReason).toBe("error");
		expect(__openTurnCountForTests()).toBe(0);
	});
});

describe("the idle backstop ends a Turn as presumed (ADR-0027)", () => {
	const recorded = () =>
		(telemetry.recordTurn as ReturnType<typeof vi.fn>).mock
			.calls as unknown as [AgentTurnRecord][];

	beforeEach(() => {
		(telemetry.recordTurn as ReturnType<typeof vi.fn>).mockClear();
	});

	/** Drive one scanner tick's StatusChange by hand: the real scanner is a
	 *  module-level setInterval, so the seam is exercised via emitStatusChange. */
	function tick(
		ptyId: string,
		rule: "idle_backstop" | "subagent_drain",
		now: number,
	) {
		const entry = usePtyActivityStore.getState().activities[ptyId];
		usePtyActivityStore.setState((s) => ({
			activities: { ...s.activities, [ptyId]: { ...entry, state: "ready" } },
		}));
		__emitStatusChangeForTests({
			ptyId,
			prev: {
				state: entry.state,
				detectionMode: entry.detectionMode,
				hookDriven: entry.hookDriven,
			},
			next: {
				state: "ready",
				detectionMode: entry.detectionMode,
				hookDriven: entry.hookDriven,
			},
			cause: { kind: "tick", now, rule },
		});
	}

	it("records presumed_end, timed from the last activity not the giving-up", async () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsP", "paneP", "ptyP")],
		});
		register("ptyP", "paneP", "copilot", "idle", false);
		usePtyActivityStore.getState().applyHookEvent("ptyP", "active", true);
		// The agent fell silent; the scanner gives up 30s after the last output.
		const lastOutput = Date.now() + 1_000;
		touchLastOutput("ptyP", lastOutput);
		tick("ptyP", "idle_backstop", lastOutput + 30_000);

		await vi.waitFor(() => expect(recorded().length).toBe(1));
		const rec = recorded()[0][0];
		expect(rec.endReason).toBe("presumed_end");
		// The 30s of silence is not billed as work.
		expect(rec.endedAt).toBe(lastOutput);
		expect(rec.workingMs).toBeLessThan(30_000);
	});

	it("keeps a Subagent-drain tick as an observed stop", async () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsD", "paneD", "ptyD")],
		});
		register("ptyD", "paneD", "claude", "idle", false);
		usePtyActivityStore.getState().applyHookEvent("ptyD", "active", true);
		// Back-date the last output far enough that a presumed end would be
		// visible; the drain path must ignore it and use its own clock.
		const stale = Date.now() - 60_000;
		touchLastOutput("ptyD", stale);
		tick("ptyD", "subagent_drain", Date.now());

		await vi.waitFor(() => expect(recorded().length).toBe(1));
		const rec = recorded()[0][0];
		// The turn-finished hook WAS observed here — only the tail length was
		// inferred, and ADR-0022 bills that tail on purpose. So: not presumed, and
		// not back-dated to the stale last-output.
		expect(rec.endReason).toBe("stop");
		expect(rec.endedAt).toBeGreaterThan(stale);
	});

	it("never bills negative time when the last activity predates the Turn", async () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsN", "paneN", "ptyN")],
		});
		register("ptyN", "paneN", "copilot", "idle", false);
		// A Turn that produced no output carries a lastOutputAt from before it began.
		touchLastOutput("ptyN", Date.now() - 60_000);
		usePtyActivityStore.getState().applyHookEvent("ptyN", "active", true);
		tick("ptyN", "idle_backstop", Date.now());

		await vi.waitFor(() => expect(recorded().length).toBe(1));
		const rec = recorded()[0][0];
		expect(rec.endReason).toBe("presumed_end");
		expect(rec.durationMs).toBeGreaterThanOrEqual(0);
		expect(rec.workingMs).toBeGreaterThanOrEqual(0);
	});

	it("a real agentStop is unaffected", async () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsS", "paneS", "ptyS")],
		});
		register("ptyS", "paneS", "claude", "idle", false);
		const a = usePtyActivityStore.getState();
		a.applyHookEvent("ptyS", "active", true);
		a.applyHookEvent("ptyS", "ready");
		await vi.waitFor(() => expect(recorded().length).toBe(1));
		expect(recorded()[0][0].endReason).toBe("stop");
	});
});

describe("only a turn-start hook opens a Turn on a hook-driven pane (ADR-0027)", () => {
	it("acknowledging a red icon with no open Turn opens none", () => {
		// The idle backstop has already finalized this pane's Turn, so nothing is
		// open when a Mid-turn failure lands and the user clicks. Restoring Working
		// on that click must not fabricate a Turn started at click time and
		// attributed to their mouse.
		//
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsA", "paneA", "ptyA")],
		});
		register("ptyA", "paneA", "copilot", "idle", false);
		const a = usePtyActivityStore.getState();
		a.applyHookEvent("ptyA", "active", true); // userPromptSubmitted
		a.applyHookEvent("ptyA", "ready"); // the backstop's effect: Turn closed
		expect(__openTurnCountForTests()).toBe(0);

		a.applyHookEvent("ptyA", "errorMidTurn"); // errorOccurred, no open Turn
		usePtyActivityStore.getState().click("ptyA");
		// The icon honestly returns to Working (the backstop's Ready was a guess,
		// and the failure proves the Turn continued) — but no Turn is fabricated.
		expect(usePtyActivityStore.getState().activities.ptyA.state).toBe("active");
		expect(__openTurnCountForTests()).toBe(0);
	});

	it("a permission reply resumes Working without opening a Turn", () => {
		// PermissionResult / permission.replied / PermissionDenied all map to
		// Working — the pane really is working again — but answering a prompt is
		// not the start of a new Turn. With the previous `transition === "working"`
		// test this opened a Turn timed from the user's answer whenever the
		// previous one was already closed by a presumed end.
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsR", "paneR", "ptyR")],
		});
		register("ptyR", "paneR", "copilot", "idle", false);
		const a = usePtyActivityStore.getState();
		a.applyHookEvent("ptyR", "active", true); // userPromptSubmitted
		a.applyHookEvent("ptyR", "ready"); // the backstop / agentStop closed it
		expect(__openTurnCountForTests()).toBe(0);

		// PermissionResult — maps to Working, but startsTurn is false.
		a.applyHookEvent("ptyR", "active");
		expect(usePtyActivityStore.getState().activities.ptyR.state).toBe("active");
		expect(__openTurnCountForTests()).toBe(0);
	});

	it("still opens a Turn when a prompt lands on a pane already at Working", () => {
		// The entry is identical across this hook (active→active, hookDriven
		// already true), so it emits no state change — but a turn-start hook is a
		// Turn boundary regardless of the icon and must still reach the seam.
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsQ", "paneQ", "ptyQ")],
		});
		register("ptyQ", "paneQ", "copilot", "active", true);
		usePtyActivityStore.getState().applyHookEvent("ptyQ", "active", true);
		expect(__openTurnCountForTests()).toBe(1);
	});

	it("the next real prompt still opens a Turn on that pane", () => {
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsB", "paneB", "ptyB")],
		});
		register("ptyB", "paneB", "copilot", "idle", false);
		const a = usePtyActivityStore.getState();
		a.applyHookEvent("ptyB", "active", true);
		a.applyHookEvent("ptyB", "ready");
		a.applyHookEvent("ptyB", "errorMidTurn");
		usePtyActivityStore.getState().click("ptyB");
		expect(__openTurnCountForTests()).toBe(0);

		// hookDriven and already at Working — the turn-start hook must still land.
		usePtyActivityStore.getState().applyHookEvent("ptyB", "active", true);
		expect(__openTurnCountForTests()).toBe(1);
	});

	it("leaves the pre-hook byte-heuristic path alone", () => {
		// Not yet hookDriven: the TUI flood legitimately opens the Turn, and the
		// first hook only flips hookDriven. Rule A must not touch this.
		useWorkspaceStore.setState({
			workspaces: [makeWorkspace("wsF", "paneF", "ptyF")],
		});
		register("ptyF", "paneF", "copilot", "idle", false);
		usePtyActivityStore.getState().recordOutput("ptyF");
		expect(__openTurnCountForTests()).toBe(1);
	});
});
