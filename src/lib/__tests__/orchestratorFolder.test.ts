import { describe, expect, it } from "vitest";
import { tildePath } from "../orchestratorFolder";

describe("tildePath", () => {
	it("writes the home folder as ~", () => {
		expect(
			tildePath(
				"/Users/me/Library/Application Support/abundio/orchestrator/Personal",
				"/Users/me",
			),
		).toBe("~/Library/Application Support/abundio/orchestrator/Personal");
		expect(tildePath("/Users/me", "/Users/me/")).toBe("~");
		expect(tildePath("C:\\Users\\me\\Orch", "C:\\Users\\me")).toBe("~\\Orch");
	});

	it("leaves other paths, and a mere name prefix, alone", () => {
		expect(tildePath("/Volumes/ssd/Orch", "/Users/me")).toBe(
			"/Volumes/ssd/Orch",
		);
		expect(tildePath("/Users/meg/Orch", "/Users/me")).toBe("/Users/meg/Orch");
		expect(tildePath("/x", "")).toBe("/x");
	});
});
