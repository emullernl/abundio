import { describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const pending: Array<() => void> = [];
vi.mock("../ipc", () => ({
	workspaces: {
		// Each write stays in flight until the test releases it, so a write
		// that did not wait for the one before it would be seen starting early.
		setRestoreOpened: vi.fn(
			(id: string, opened: boolean) =>
				new Promise<void>((resolve) => {
					calls.push(`${id}=${opened}`);
					pending.push(resolve);
				}),
		),
		setRestoreActive: vi.fn(() => Promise.resolve()),
	},
}));

import { forgetOpened, pickActive, rememberOpened } from "../workspaceRestore";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("writes to one row (review of #253)", () => {
	it("land in the order they were made, each after the last one finished", async () => {
		forgetOpened("w");
		rememberOpened("w");
		await flush();
		expect(calls).toEqual(["w=false"]);
		pending.shift()?.();
		await flush();
		expect(calls).toEqual(["w=false", "w=true"]);
		pending.shift()?.();
	});
});

describe("pickActive", () => {
	it("keeps the remembered Active workspace when it came back", () => {
		expect(pickActive({ opened: ["a", "b"], active: "b" })).toBe("b");
	});

	it("falls back to the first restored one when it did not", () => {
		expect(pickActive({ opened: ["a", "b"], active: "x" })).toBe("a");
		expect(pickActive({ opened: ["a", "b"], active: null })).toBe("a");
	});

	it("is none when nothing was restored", () => {
		expect(pickActive({ opened: [], active: "a" })).toBeNull();
	});
});
