import { describe, expect, it } from "vitest";
import { oneLine, typedLine } from "../typedLine";

describe("typedLine", () => {
	// LF reaches PowerShell through ConPTY as Ctrl+Enter ("insert a line"),
	// so the command never ran. CR is what a real Enter key sends.
	it("presses Enter with CR, never LF", () => {
		expect(typedLine("claude")).toBe("claude\r");
		expect(typedLine("claude")).not.toContain("\n");
	});

	it("keeps the line's own spaces and arguments", () => {
		expect(typedLine("claude --resume abc-123")).toBe(
			"claude --resume abc-123\r",
		);
	});

	// A newline inside the line would run the first half as its own command.
	it("turns an embedded newline or CR into a space", () => {
		expect(typedLine("claude\nrm -rf x")).toBe("claude rm -rf x\r");
		expect(typedLine("claude\r--flag")).toBe("claude --flag\r");
	});

	it("strips escape sequences' control bytes", () => {
		expect(typedLine("a\x1b[201~b")).toBe("a [201~b\r");
	});
});

describe("oneLine", () => {
	it("trims the ends", () => {
		expect(oneLine("  ls\n")).toBe("ls");
	});

	it("is empty for control characters only", () => {
		expect(oneLine("\r\n\t")).toBe("");
	});
});
