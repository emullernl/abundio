import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createWorktreeProgress,
	type WorktreeProgressDisplay,
} from "../useWorktreeProgress";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const PROGRESS = { status: "progress" } as Partial<WorktreeProgressDisplay>;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createWorktreeProgress", () => {
	it("never shows the modal when the op finishes before the show delay", async () => {
		const setDisplay = vi.fn();
		const { run } = createWorktreeProgress(setDisplay);
		const d = deferred<void>();

		const p = run({ verb: "Creating", target: "feat/x" }, () => d.promise);
		await vi.advanceTimersByTimeAsync(50); // still well before the 150ms delay
		d.resolve();
		await p;

		expect(setDisplay).not.toHaveBeenCalledWith(
			expect.objectContaining(PROGRESS),
		);
	});

	it("shows progress after the delay and holds it for the minimum", async () => {
		const setDisplay = vi.fn();
		const { run } = createWorktreeProgress(setDisplay);
		const d = deferred<void>();

		const p = run({ verb: "Removing", target: "'x'" }, () => d.promise);

		await vi.advanceTimersByTimeAsync(150);
		expect(setDisplay).toHaveBeenCalledWith({
			verb: "Removing",
			target: "'x'",
			status: "progress",
		});

		// Op finishes only 50ms after the modal appeared — must keep holding.
		await vi.advanceTimersByTimeAsync(50);
		d.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(setDisplay).not.toHaveBeenLastCalledWith(null);

		// Reach the 400ms minimum hold, then it hides.
		await vi.advanceTimersByTimeAsync(350);
		await p;
		expect(setDisplay).toHaveBeenLastCalledWith(null);
	});

	it("flips straight to the error state, bypassing the show delay", async () => {
		const setDisplay = vi.fn();
		const { run } = createWorktreeProgress(setDisplay);

		const result = await run({ verb: "Creating", target: "feat/x" }, () =>
			Promise.reject(new Error("target folder already exists")),
		);

		expect(result).toEqual({
			ok: false,
			error: "target folder already exists",
		});
		expect(setDisplay).toHaveBeenLastCalledWith({
			verb: "Creating",
			target: "feat/x",
			status: "error",
			error: "target folder already exists",
		});
		expect(setDisplay).not.toHaveBeenCalledWith(
			expect.objectContaining(PROGRESS),
		);
	});

	it("shows progress, then flips to error if it fails after the delay", async () => {
		const setDisplay = vi.fn();
		const { run } = createWorktreeProgress(setDisplay);
		const d = deferred<void>();

		const p = run({ verb: "Removing", target: "'x'" }, () => d.promise);
		await vi.advanceTimersByTimeAsync(150);
		expect(setDisplay).toHaveBeenLastCalledWith(
			expect.objectContaining(PROGRESS),
		);

		d.reject(new Error("worktree is locked"));
		await p;
		expect(setDisplay).toHaveBeenLastCalledWith(
			expect.objectContaining({ status: "error", error: "worktree is locked" }),
		);
	});

	it("dismiss clears the display", () => {
		const setDisplay = vi.fn();
		const { dismiss } = createWorktreeProgress(setDisplay);
		dismiss();
		expect(setDisplay).toHaveBeenCalledWith(null);
	});
});
