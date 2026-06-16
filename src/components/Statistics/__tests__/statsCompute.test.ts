import { describe, expect, it } from "vitest";
import type { AgentTurnBucket } from "../../../lib/ipc";
import { densifyBuckets } from "../statsCompute";

function bucket(key: string, turnCount: number): AgentTurnBucket {
	return {
		bucket: key,
		agentId: null,
		workspaceId: null,
		workspaceName: null,
		turnCount,
		attributedTurnCount: 0,
		totalDurationMs: 0,
		totalWorkingMs: 0,
		totalWaitingMs: 0,
		totalLinesAdded: 0,
		totalLinesDeleted: 0,
		totalFilesChanged: 0,
		totalPermissionRequests: 0,
		totalToolCalls: 0,
		totalErrors: 0,
	};
}

describe("densifyBuckets", () => {
	it("fills every day in a 7-day window, keeping the one with data and zeroing the rest", () => {
		const from = new Date(2026, 2, 10).getTime(); // Mar 10 local
		const to = new Date(2026, 2, 17).getTime(); // Mar 17 (exclusive)
		const dense = densifyBuckets([bucket("2026-03-12", 5)], from, to, "day");

		expect(dense).toHaveLength(7);
		expect(dense[0].bucket).toBe("2026-03-10");
		expect(dense[6].bucket).toBe("2026-03-16");
		// Ascending order.
		expect([...dense].sort((a, b) => a.bucket.localeCompare(b.bucket))).toEqual(
			dense,
		);
		// Exactly the data day carries its count; the rest are zero.
		expect(dense.find((b) => b.bucket === "2026-03-12")?.turnCount).toBe(5);
		expect(dense.filter((b) => b.turnCount > 0)).toHaveLength(1);
	});

	it("fills months across a year window", () => {
		const from = new Date(2026, 0, 1).getTime();
		const to = new Date(2027, 0, 1).getTime();
		const dense = densifyBuckets([bucket("2026-04", 3)], from, to, "month");
		expect(dense).toHaveLength(12);
		expect(dense[0].bucket).toBe("2026-01");
		expect(dense.find((b) => b.bucket === "2026-04")?.turnCount).toBe(3);
	});

	it("clamps an all-time (epoch) start to the earliest data bucket", () => {
		const to = new Date(2027, 0, 1).getTime();
		// fromMs = 0 (epoch) would enumerate decades; clamp to first data year.
		const dense = densifyBuckets(
			[bucket("2025", 1), bucket("2026", 2)],
			0,
			to,
			"year",
		);
		expect(dense.map((b) => b.bucket)).toEqual(["2025", "2026"]);
	});

	it("returns nothing for an empty window with no data", () => {
		const from = new Date(2026, 2, 10).getTime();
		expect(densifyBuckets([], from, from, "day")).toHaveLength(0);
	});
});
