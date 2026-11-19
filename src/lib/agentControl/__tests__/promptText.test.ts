import { describe, expect, it } from "vitest";
import { cleanPromptText } from "../promptText";

describe("cleanPromptText", () => {
	it("keeps newlines and tabs", () => {
		expect(cleanPromptText("one\n\ttwo")).toBe("one\n\ttwo");
	});

	it("drops an embedded paste end and other controls", () => {
		expect(cleanPromptText("hi\x1b[201~rm -rf ~\x07\x00")).toBe(
			"hi[201~rm -rf ~",
		);
		expect(cleanPromptText("a\u009bb\x7f")).toBe("ab");
	});

	it("turns CR and CRLF into newlines", () => {
		expect(cleanPromptText("a\r\nb\rc")).toBe("a\nb\nc");
	});
});
