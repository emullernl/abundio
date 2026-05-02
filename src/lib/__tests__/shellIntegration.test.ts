import { describe, expect, it } from "vitest";
import { parseShellIntegration } from "../shellIntegration";

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("parseShellIntegration", () => {
	it("returns original data and empty commands when no sequences present", () => {
		const data = encode("hello world");
		const result = parseShellIntegration(data);
		expect(result.cleaned).toBe(data);
		expect(result.commands).toEqual([]);
	});

	it("parses command_start sequence without command text", () => {
		const data = encode("\x1b]7770;command_start\x07");
		const result = parseShellIntegration(data);
		expect(result.cleaned.length).toBe(0);
		expect(result.commands).toEqual([
			{ type: "command_start", commandText: undefined },
		]);
	});

	it("parses command_start with command text", () => {
		const data = encode("\x1b]7770;command_start;claude\x07");
		const result = parseShellIntegration(data);
		expect(result.cleaned.length).toBe(0);
		expect(result.commands).toEqual([
			{ type: "command_start", commandText: "claude" },
		]);
	});

	it("parses command_start with full command line", () => {
		const data = encode("\x1b]7770;command_start;npx claude --model opus\x07");
		const result = parseShellIntegration(data);
		expect(result.cleaned.length).toBe(0);
		expect(result.commands).toEqual([
			{ type: "command_start", commandText: "npx claude --model opus" },
		]);
	});

	it("parses command_end with exit code 0", () => {
		const data = encode("\x1b]7770;command_end;0\x07");
		const result = parseShellIntegration(data);
		expect(result.cleaned.length).toBe(0);
		expect(result.commands).toEqual([{ type: "command_end", exitCode: 0 }]);
	});

	it("parses command_end with non-zero exit code", () => {
		const data = encode("\x1b]7770;command_end;1\x07");
		const result = parseShellIntegration(data);
		expect(result.cleaned.length).toBe(0);
		expect(result.commands).toEqual([{ type: "command_end", exitCode: 1 }]);
	});

	it("parses multiple sequences in one chunk", () => {
		const data = encode(
			"\x1b]7770;command_start\x07\x1b]7770;command_end;0\x07",
		);
		const result = parseShellIntegration(data);
		expect(result.cleaned.length).toBe(0);
		expect(result.commands).toEqual([
			{ type: "command_start", commandText: undefined },
			{ type: "command_end", exitCode: 0 },
		]);
	});

	it("handles sequences interleaved with regular output", () => {
		const data = encode(
			"before\x1b]7770;command_start\x07middle\x1b]7770;command_end;42\x07after",
		);
		const result = parseShellIntegration(data);
		const cleanedStr = new TextDecoder().decode(result.cleaned);
		expect(cleanedStr).toBe("beforemiddleafter");
		expect(result.commands).toEqual([
			{ type: "command_start", commandText: undefined },
			{ type: "command_end", exitCode: 42 },
		]);
	});

	it("keeps partial sequence at end of data in cleaned output", () => {
		const data = encode("hello\x1b]7770;command_st");
		const result = parseShellIntegration(data);
		const cleanedStr = new TextDecoder().decode(result.cleaned);
		expect(cleanedStr).toBe("hello\x1b]7770;command_st");
		expect(result.commands).toEqual([]);
	});

	it("parses cwd_change sequence", () => {
		const data = encode("\x1b]7770;cwd;/Users/foo/bar\x07");
		const result = parseShellIntegration(data);
		expect(result.cleaned.length).toBe(0);
		expect(result.commands).toEqual([
			{ type: "cwd_change", path: "/Users/foo/bar" },
		]);
	});

	it("parses cwd_change interleaved with other sequences", () => {
		const data = encode(
			"\x1b]7770;command_end;0\x07\x1b]7770;cwd;/home/user/project\x07",
		);
		const result = parseShellIntegration(data);
		expect(result.cleaned.length).toBe(0);
		expect(result.commands).toEqual([
			{ type: "command_end", exitCode: 0 },
			{ type: "cwd_change", path: "/home/user/project" },
		]);
	});
});
