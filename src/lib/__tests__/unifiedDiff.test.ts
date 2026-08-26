import { describe, expect, it } from "vitest";
import { isUnifiedDiffFile, parseUnifiedDiff } from "../unifiedDiff";

describe("parseUnifiedDiff", () => {
	it("reconstructs both sides of a unified diff", () => {
		const result = parseUnifiedDiff(
			[
				"diff --git a/src/app.ts b/src/app.ts",
				"--- a/src/app.ts",
				"+++ b/src/app.ts",
				"@@ -1,3 +1,3 @@",
				" const app = createApp();",
				"-app.start();",
				"+app.listen(3000);",
			].join("\n"),
		);

		expect(result.original).toBe("const app = createApp();\napp.start();");
		expect(result.modified).toBe("const app = createApp();\napp.listen(3000);");
	});

	it("keeps non-unified patch content readable", () => {
		const result = parseUnifiedDiff("Patch failed");
		expect(result.original).toBe("");
		expect(result.modified).toBe("Patch failed");
	});

	it("preserves marker-like content and separates multiple files", () => {
		const result = parseUnifiedDiff(
			[
				"diff --git a/a.yml b/a.yml",
				"--- a/a.yml",
				"+++ b/a.yml",
				"@@ -1 +1 @@",
				"----",
				"++++",
				"diff --git a/b.js b/b.js",
				"--- a/b.js",
				"+++ b/b.js",
				"@@ -1 +1 @@",
				"-old",
				"+new",
			].join("\r\n"),
		);

		expect(result.original).toContain("---");
		expect(result.modified).toContain("+++");
		expect(result.original).toContain("=== a.yml ===");
		expect(result.modified).toContain("=== a.yml ===");
		expect(result.languagePath).toBe("a.yml");
	});
});

describe("isUnifiedDiffFile", () => {
	it("requires a diff extension and unified diff markers", () => {
		expect(isUnifiedDiffFile("change.diff", "--- a/file\n+++ b/file")).toBe(
			true,
		);
		expect(isUnifiedDiffFile("change.txt", "--- a/file\n+++ b/file")).toBe(
			false,
		);
		expect(isUnifiedDiffFile("change.diff", "plain text")).toBe(false);
	});
});
