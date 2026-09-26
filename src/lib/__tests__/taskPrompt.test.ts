import { describe, expect, it } from "vitest";
import {
	DEFAULT_ISSUE_TEMPLATE,
	DEFAULT_TASK_TEMPLATE,
	resolveTaskPrompt,
	suggestBranchForIssue,
	taskTabName,
} from "../taskPrompt";

const templates = {
	taskTemplate:
		"Hi, here's the input from the user: {{input}}. Make sure it gets done.",
	issueTemplate: "Work on #{{number}} ({{title}}) at {{url}}.",
};
const issue = {
	number: 42,
	title: "Fix login redirect",
	url: "https://github.com/acme/app/issues/42",
};

describe("resolveTaskPrompt", () => {
	it("fills the task template with the input", () => {
		expect(
			resolveTaskPrompt({ kind: "text", input: "  add dark mode " }, templates),
		).toBe(
			"Hi, here's the input from the user: add dark mode. Make sure it gets done.",
		);
	});

	it("fills the issue template with number, title and url", () => {
		expect(resolveTaskPrompt({ kind: "issue", issue }, templates)).toBe(
			"Work on #42 (Fix login redirect) at https://github.com/acme/app/issues/42.",
		);
	});

	it("appends a note as its own paragraph, and nothing when empty", () => {
		expect(
			resolveTaskPrompt(
				{ kind: "issue", issue, note: " use the v2 API " },
				templates,
			),
		).toBe(
			"Work on #42 (Fix login redirect) at https://github.com/acme/app/issues/42.\n\nuse the v2 API",
		);
		expect(
			resolveTaskPrompt({ kind: "issue", issue, note: "   " }, templates),
		).toBe(resolveTaskPrompt({ kind: "issue", issue }, templates));
	});

	it("strips control characters from values but keeps newlines in the input", () => {
		const out = resolveTaskPrompt(
			{ kind: "text", input: "line one\r\nline\u001b[201~ two" },
			{ ...templates, taskTemplate: "{{input}}" },
		);
		expect(out).toBe("line one\nline[201~ two");
		expect(
			resolveTaskPrompt(
				{ kind: "issue", issue: { ...issue, title: "a\u001bb\nc" } },
				templates,
			),
		).toContain("(abc)");
	});

	it("does not strip the template itself", () => {
		expect(
			resolveTaskPrompt(
				{ kind: "text", input: "x" },
				{ ...templates, taskTemplate: "Step 1\n\tStep 2: {{input}}" },
			),
		).toBe("Step 1\n\tStep 2: x");
	});

	it("leaves unknown placeholders as written, including object keys", () => {
		expect(
			resolveTaskPrompt(
				{ kind: "text", input: "x" },
				{ ...templates, taskTemplate: "{{input}} {{nope}} {{toString}}" },
			),
		).toBe("x {{nope}} {{toString}}");
	});

	it("does not interpret $ patterns in values", () => {
		expect(
			resolveTaskPrompt(
				{ kind: "text", input: "cost $& $1" },
				{ ...templates, taskTemplate: "{{input}}" },
			),
		).toBe("cost $& $1");
	});

	it("has defaults that use their placeholders", () => {
		expect(DEFAULT_TASK_TEMPLATE).toContain("{{input}}");
		expect(DEFAULT_ISSUE_TEMPLATE).toContain("{{number}}");
	});
});

describe("taskTabName", () => {
	it("names an issue task by number and title", () => {
		expect(taskTabName({ kind: "issue", issue })).toBe(
			"#42 Fix login redirect",
		);
	});

	it("uses one line of the free text, shortened with an ellipsis", () => {
		const name = taskTabName({
			kind: "text",
			input: "Refactor the\nwhole settings store into smaller slices please",
		});
		expect(name).toBe("Refactor the whole settings s…");
		expect(name.length).toBeLessThanOrEqual(30);
	});

	it("falls back to Task for empty text", () => {
		expect(taskTabName({ kind: "text", input: "  " })).toBe("Task");
	});
});

describe("suggestBranchForIssue", () => {
	it("slugs the title", () => {
		expect(suggestBranchForIssue(issue)).toBe("issue-42-fix-login-redirect");
	});

	it("drops accents and punctuation and caps the length", () => {
		expect(
			suggestBranchForIssue({
				...issue,
				title: "Café: crash on ../../ paths!!",
			}),
		).toBe("issue-42-cafe-crash-on-paths");
		const long = suggestBranchForIssue({ ...issue, title: "a ".repeat(60) });
		expect(long.length).toBeLessThanOrEqual("issue-42-".length + 40);
		expect(long.endsWith("-")).toBe(false);
	});

	it("uses the number alone when the title has no usable characters", () => {
		expect(suggestBranchForIssue({ ...issue, title: "日本語" })).toBe(
			"issue-42",
		);
	});
});
