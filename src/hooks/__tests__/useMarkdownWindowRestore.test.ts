import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/ipc", () => ({ markdownWindows: { restore: vi.fn() } }));

import { newlyOpened } from "../useMarkdownWindowRestore";

describe("newlyOpened", () => {
	it("lists only ids that just became Opened", () => {
		expect(newlyOpened(new Set(["a"]), new Set(["a", "b"]))).toEqual(["b"]);
		expect(newlyOpened(new Set(["a", "b"]), new Set(["a"]))).toEqual([]);
		expect(newlyOpened(new Set(), new Set())).toEqual([]);
	});
});
