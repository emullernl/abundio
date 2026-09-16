import { describe, expect, it } from "vitest";
import { decideWindowClose } from "../closeDecision";

describe("decideWindowClose", () => {
	it("proceeds when there is nothing at stake", () => {
		expect(decideWindowClose(0, false)).toBe("proceed");
	});

	it("proceeds when workspaces are open but nothing is busy", () => {
		// The point of ADR-0034: a Window full of idle shells closes without
		// asking. Everything it holds is restored on relaunch.
		expect(decideWindowClose(0, false)).toBe("proceed");
	});

	it("confirms when something is busy and nothing is dirty", () => {
		expect(decideWindowClose(0, true)).toBe("workspace-confirm");
	});

	it("lets the Save dialog win when files are dirty, busy or not", () => {
		expect(decideWindowClose(1, false)).toBe("save-confirm");
		expect(decideWindowClose(3, true)).toBe("save-confirm");
	});
});
