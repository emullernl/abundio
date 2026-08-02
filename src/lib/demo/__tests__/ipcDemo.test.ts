import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration check on the `ipc.ts` chokepoint with demo mode on. Importing
 * `../../ipc` here also proves the demo import cycle (ipc → demo/mockInvoke →
 * stores → ipc) resolves without a load-time crash, since the test runs through
 * the same Vite transform as the app.
 */
describe("ipc chokepoint in demo mode", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.stubEnv("VITE_ABUNDIO_DEMO", "true");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("routes invoke() to fixtures", async () => {
		const ipc = await import("../../ipc");
		const ws = await ipc.workspaces.list("demo-personal");
		expect(ws.length).toBeGreaterThan(0);
		expect(ws[0].tabs.length).toBeGreaterThan(0);

		const snapshot = await ipc.pr.snapshot();
		expect(snapshot?.available).toBe(true);
		expect(Array.isArray(snapshot?.reviewRequested)).toBe(true);
	});

	it("delivers a git-state bundle through listen()", async () => {
		const ipc = await import("../../ipc");
		const bundle = await new Promise((resolve) => {
			ipc.git.onGitState("ws-acme", (event) => resolve(event));
		});
		expect(bundle).toEqual(expect.objectContaining({ kind: "bundle" }));
	});

	it("delivers a pane transcript on pty-output after spawn", async () => {
		const ipc = await import("../../ipc");
		const fixtures = await import("../fixtures");
		// Any agent pane has a transcript; pick the first one.
		const paneId = Object.keys(fixtures.agentPanes).find(
			(id) => fixtures.agentPanes[id].mode === "agent",
		);
		expect(paneId).toBeDefined();
		const ptyId = "pty-test-1";
		const received = new Promise<Uint8Array>((resolve) => {
			ipc.pty.onOutput(ptyId, (data) => resolve(data));
		});
		await ipc.pty.spawn({
			cwd: "/x",
			cols: 80,
			rows: 24,
			logId: paneId,
			ptyId,
		});
		const data = await received;
		expect(data.byteLength).toBeGreaterThan(0);
	});
});
