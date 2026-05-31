import { describe, expect, it } from "vitest";
import { detectLanguage } from "../monacoShared";

describe("detectLanguage", () => {
	it("detects astro files", () => {
		expect(detectLanguage("src/pages/index.astro")).toBe("astro");
		expect(detectLanguage("Index.ASTRO")).toBe("astro");
	});

	it("detects common languages from the path extension", () => {
		expect(detectLanguage("foo.ts")).toBe("typescript");
		expect(detectLanguage("foo.tsx")).toBe("typescript");
		expect(detectLanguage("foo.rs")).toBe("rust");
		expect(detectLanguage("foo.cls")).toBe("apex");
	});

	it("returns undefined for unknown or extensionless paths", () => {
		expect(detectLanguage("foo.unknownext")).toBeUndefined();
		expect(detectLanguage("Makefile")).toBeUndefined();
	});
});
