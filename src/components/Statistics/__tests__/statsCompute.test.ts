import { describe, expect, it } from "vitest";
import type { AgentTurnBucket, AgentTurnRecord } from "../../../lib/ipc";
import {
	densifyBuckets,
	formatCompactCount,
	turnsToCsv,
} from "../statsCompute";

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

describe("formatCompactCount", () => {
	it("keeps counts below 10,000 exact with thousands separators", () => {
		expect(formatCompactCount(0)).toBe("0");
		expect(formatCompactCount(847)).toBe("847");
		expect(formatCompactCount(1234)).toBe("1,234");
		expect(formatCompactCount(9999)).toBe("9,999");
	});

	it("abbreviates thousands with a K suffix at/above 10,000", () => {
		expect(formatCompactCount(10_000)).toBe("10K");
		expect(formatCompactCount(12_345)).toBe("12.3K");
		expect(formatCompactCount(123_456)).toBe("123.5K");
	});

	it("abbreviates millions with an M suffix and rolls over correctly", () => {
		expect(formatCompactCount(999_999)).toBe("1M");
		expect(formatCompactCount(1_234_567)).toBe("1.2M");
		expect(formatCompactCount(12_345_678)).toBe("12.3M");
	});
});

function turn(overrides: Partial<AgentTurnRecord> = {}): AgentTurnRecord {
	return {
		id: "t1",
		sessionId: null,
		profileId: "p1",
		workspaceId: "w1",
		workspacePath: "/home/user/proj",
		workspaceName: "proj",
		agentId: "claude",
		ptyId: "pty1",
		startedAt: Date.UTC(2026, 2, 12, 9, 30),
		endedAt: Date.UTC(2026, 2, 12, 9, 45),
		durationMs: 900_000,
		workingMs: 600_000,
		waitingMs: 300_000,
		endReason: "completed",
		permissionRequestsCount: 1,
		errorCount: 0,
		linesAdded: 42,
		linesDeleted: 7,
		filesChanged: 3,
		gitAddedStart: null,
		gitDeletedStart: null,
		gitAddedEnd: null,
		gitDeletedEnd: null,
		createdAt: 0,
		...overrides,
	};
}

describe("turnsToCsv", () => {
	it("emits a header and one CRLF-terminated row per turn", () => {
		const csv = turnsToCsv([turn(), turn({ id: "t2" })]);
		const lines = csv.split("\r\n");
		expect(lines).toHaveLength(3); // header + 2 rows
		expect(lines[0].startsWith("id,agent,agent_id,workspace")).toBe(true);
		expect(lines[1]).toContain("t1");
		expect(lines[2]).toContain("t2");
	});

	it("maps agent ids to friendly labels and timestamps to ISO-8601", () => {
		const csv = turnsToCsv([turn()]);
		const row = csv.split("\r\n")[1];
		expect(row).toContain("Claude Code");
		expect(row).toContain("2026-03-12T09:30:00.000Z");
	});

	it("renders unmeasured (null) line/file counts as empty cells", () => {
		const csv = turnsToCsv([
			turn({ linesAdded: null, linesDeleted: null, filesChanged: null }),
		]);
		// Trailing columns are lines_added,lines_deleted,files_changed → three
		// empty fields, i.e. the row ends with ",,,".
		expect(csv.split("\r\n")[1].endsWith(",,,")).toBe(true);
	});

	it("escapes fields containing commas or quotes per RFC-4180", () => {
		const csv = turnsToCsv([
			turn({ workspaceName: 'my, "weird" proj', workspacePath: "/a/b" }),
		]);
		const row = csv.split("\r\n")[1];
		expect(row).toContain('"my, ""weird"" proj"');
	});

	it("neutralizes spreadsheet formula injection in user-controlled fields", () => {
		// A folder literally named like a formula must not be emitted as one.
		for (const name of ["=cmd", "+1", "-rf", "@SUM(A1)"]) {
			const csv = turnsToCsv([turn({ workspaceName: name })]);
			const row = csv.split("\r\n")[1];
			// Prefixed with a leading ' inside quotes so spreadsheets treat it as text.
			expect(row).toContain(`"'${name}"`);
		}
		// A benign name is left unquoted.
		expect(
			turnsToCsv([turn({ workspaceName: "proj" })]).split("\r\n")[1],
		).toContain(",proj,");
	});

	it("returns just the header for an empty list", () => {
		const csv = turnsToCsv([]);
		expect(csv.split("\r\n")).toHaveLength(1);
		expect(csv).toContain("files_changed");
	});
});
