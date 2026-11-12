import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let releaseRaise: () => void = () => {};
vi.mock("../ipc", () => ({
	fileWindows: {
		restore: vi.fn(async () => {}),
		raise: vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseRaise = () => {
						calls.push("raise");
						resolve();
					};
				}),
		),
		focus: vi.fn(async (label: string) => {
			calls.push(`focus:${label}`);
		}),
	},
}));

import { focusFileWindow, raiseFileWindows } from "../fileWindowRaise";
import { fileWindows } from "../ipc";

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	calls.length = 0;
	vi.mocked(fileWindows.raise).mockClear();
});

describe("focusFileWindow", () => {
	it("waits for the Workspace's raise in flight, so focus lands last", async () => {
		void raiseFileWindows("w1");
		const done = focusFileWindow("w1", "md-1");
		await flush();
		expect(calls).toEqual([]);
		releaseRaise();
		await done;
		expect(calls).toEqual(["raise", "focus:md-1"]);
		// One raise only: focusing never starts a raise of its own.
		expect(fileWindows.raise).toHaveBeenCalledTimes(1);
	});

	it("focuses straight away when nothing is being raised", async () => {
		await focusFileWindow("w2", "md-2");
		expect(calls).toEqual(["focus:md-2"]);
		expect(fileWindows.raise).not.toHaveBeenCalled();
	});

	it("never rejects when the window is gone", async () => {
		vi.mocked(fileWindows.focus).mockRejectedValueOnce(new Error("NotFound"));
		await expect(focusFileWindow("w3", "md-x")).resolves.toBeUndefined();
	});
});
