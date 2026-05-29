import { describe, expect, it } from "vitest";
import {
	cpuColor,
	cpuTooltip,
	formatBytes,
	formatPercent,
	memoryPercent,
	memoryTooltip,
} from "../metricsFormat";

describe("formatPercent", () => {
	it("renders rounded integer percent", () => {
		expect(formatPercent(12.4)).toBe("12%");
		expect(formatPercent(12.6)).toBe("13%");
		expect(formatPercent(100)).toBe("100%");
	});

	it("handles zero / invalid input", () => {
		expect(formatPercent(0)).toBe("0%");
		expect(formatPercent(-1)).toBe("0%");
		expect(formatPercent(Number.NaN)).toBe("0%");
	});
});

describe("memoryPercent", () => {
	it("computes used/total ratio", () => {
		expect(memoryPercent(12 * 1024 ** 3, 16 * 1024 ** 3)).toBeCloseTo(75);
		expect(memoryPercent(8 * 1024 ** 3, 16 * 1024 ** 3)).toBeCloseTo(50);
	});

	it("guards against zero / invalid total", () => {
		expect(memoryPercent(5, 0)).toBe(0);
		expect(memoryPercent(Number.NaN, 16)).toBe(0);
	});
});

describe("formatBytes", () => {
	it("renders integer MB below 1 GB", () => {
		expect(formatBytes(341 * 1024 ** 2)).toBe("341 MB");
	});

	it("renders one-decimal GB at or above 1 GB", () => {
		expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
		expect(formatBytes(12 * 1024 ** 3)).toBe("12.0 GB");
	});

	it("handles zero / invalid input", () => {
		expect(formatBytes(0)).toBe("0 MB");
		expect(formatBytes(-5)).toBe("0 MB");
		expect(formatBytes(Number.NaN)).toBe("0 MB");
	});
});

describe("cpuColor", () => {
	it("is neutral when calm, amber when elevated, red when high", () => {
		expect(cpuColor(10)).toBe("var(--fg-secondary)");
		expect(cpuColor(84)).toBe("var(--fg-secondary)");
		expect(cpuColor(85)).toBe("var(--warning)");
		expect(cpuColor(94)).toBe("var(--warning)");
		expect(cpuColor(95)).toBe("var(--error)");
		expect(cpuColor(100)).toBe("var(--error)");
	});

	it("treats invalid values as calm", () => {
		expect(cpuColor(Number.NaN)).toBe("var(--fg-secondary)");
	});
});

describe("tooltips", () => {
	it("formats cpu tooltip with one decimal and system-wide note", () => {
		expect(cpuTooltip(12.4)).toContain("12.4%");
		expect(cpuTooltip(12.96)).toContain("13.0%");
		expect(cpuTooltip(0)).toContain("0.0%");
		expect(cpuTooltip(12.4)).toContain("system-wide");
	});

	it("formats memory tooltip with used/total GB and percent", () => {
		const t = memoryTooltip(12 * 1024 ** 3, 16 * 1024 ** 3);
		expect(t).toContain("12.0 GB");
		expect(t).toContain("16.0 GB");
		expect(t).toContain("75%");
		expect(t).toContain("system-wide");
	});
});
