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
		expect(parseUnifiedDiff("Patch failed").modified).toBe("Patch failed");
	});
});

describe("isUnifiedDiffFile", () => {
	it("requires a diff extension and unified diff markers", () => {
		expect(isUnifiedDiffFile("change.diff", "--- a/file\n+++ b/file")).toBe(true);
		expect(isUnifiedDiffFile("change.txt", "--- a/file\n+++ b/file")).toBe(false);
		expect(isUnifiedDiffFile("change.diff", "plain text")).toBe(false);
	});
});
