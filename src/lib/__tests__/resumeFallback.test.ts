import { describe, expect, it } from "vitest";
import { fallbackAfterExit, RESUME_FALLBACK_MS } from "../resumeFallback";

describe("fallbackAfterExit", () => {
	const fb = { command: "claude", until: 1000 + RESUME_FALLBACK_MS };

	it("starts the Agent plainly when the resume fails at once", () => {
		expect(fallbackAfterExit(fb, 1, 2000)).toBe("claude");
	});
	it("does nothing when the resume worked or the exit is unknown", () => {
		expect(fallbackAfterExit(fb, 0, 2000)).toBeNull();
		expect(fallbackAfterExit(fb, null, 2000)).toBeNull();
		expect(fallbackAfterExit(null, 1, 2000)).toBeNull();
	});
	it("does not retry an Agent the user quit after using it", () => {
		expect(fallbackAfterExit(fb, 1, fb.until + 1)).toBeNull();
	});
});
