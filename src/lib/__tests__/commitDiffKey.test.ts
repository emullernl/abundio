import { describe, expect, it } from "vitest";
import {
	commitDiffKey,
	diffPaneName,
	diffRealPath,
	parseCommitDiffKey,
} from "../commitDiffKey";

const OID = "9f3e1a7c0ffee00000000000000000000000beef";

describe("commitDiffKey", () => {
	it("round-trips, including a path that contains a colon", () => {
		const key = commitDiffKey(OID, "docs/a:b.md");
		expect(parseCommitDiffKey(key)).toEqual({ oid: OID, path: "docs/a:b.md" });
	});

	it("does not start with `diff:`, so live-diff paths leave it alone", () => {
		expect(commitDiffKey(OID, "a.ts").startsWith("diff:")).toBe(false);
	});

	it("rejects live diff keys and plain paths", () => {
		expect(parseCommitDiffKey("diff:src/a.ts")).toBeNull();
		expect(parseCommitDiffKey("/abs/diff@x:y")).toBeNull();
		expect(parseCommitDiffKey("diff@nothex:a.ts")).toBeNull();
	});
});

describe("diffRealPath", () => {
	it("strips either prefix and passes other paths through", () => {
		expect(diffRealPath("diff:src/a.ts")).toBe("src/a.ts");
		expect(diffRealPath(commitDiffKey(OID, "src/a.ts"))).toBe("src/a.ts");
		expect(diffRealPath("/abs/a.ts")).toBe("/abs/a.ts");
	});
});

describe("diffPaneName", () => {
	it("names a live diff and a commit diff differently", () => {
		expect(diffPaneName("diff:src/a.ts")).toBe("a.ts (diff)");
		expect(diffPaneName(commitDiffKey(OID, "src/a.ts"))).toBe("a.ts @ 9f3e1a7");
	});
});
