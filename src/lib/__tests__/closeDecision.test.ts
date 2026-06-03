import { describe, expect, it } from "vitest";
import { decideWindowClose } from "../closeDecision";

describe("decideWindowClose", () => {
	it("proceeds when there is nothing at stake", () => {
		expect(decideWindowClose(0, 0)).toBe("proceed");
	});

	it("confirms the workspace close when ≥1 opened and nothing is dirty", () => {
		expect(decideWindowClose(0, 1)).toBe("workspace-confirm");
		expect(decideWindowClose(0, 5)).toBe("workspace-confirm");
	});

	it("lets the Save dialog win when files are dirty, regardless of opened count", () => {
		expect(decideWindowClose(1, 0)).toBe("save-confirm");
		expect(decideWindowClose(3, 4)).toBe("save-confirm");
	});
});
