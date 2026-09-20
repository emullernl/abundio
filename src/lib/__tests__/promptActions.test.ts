import { describe, expect, it } from "vitest";
import {
	actionsForPane,
	allFilled,
	buttonLabel,
	canFire,
	deriveParams,
	initialValues,
	isInScope,
	isRequired,
	orphanedParamMeta,
	type ParamMetaMap,
	type PromptAction,
	positionNumber,
	resolveBody,
	resolveValue,
	stripControlChars,
} from "../promptActions";

function action(over: Partial<PromptAction> = {}): PromptAction {
	return {
		id: "a1",
		name: "Review",
		body: "/review",
		scope: { kind: "all" },
		params: {},
		showInBar: true,
		position: 0,
		createdAt: 0,
		updatedAt: 0,
		...over,
	};
}

describe("deriveParams", () => {
	it("derives in order of first appearance", () => {
		const params = deriveParams("Fix {{file}} for {{reason}}");
		expect(params.map((p) => p.name)).toEqual(["file", "reason"]);
	});

	it("treats a placeholder used twice as one parameter", () => {
		const params = deriveParams("Open {{file}}, then re-read {{file}}");
		expect(params.map((p) => p.name)).toEqual(["file"]);
	});

	it("defaults an underived parameter to text", () => {
		expect(deriveParams("{{x}}")[0].meta.type).toBe("text");
	});

	it("attaches supplied metadata by name", () => {
		const meta: ParamMetaMap = { n: { type: "number", defaultValue: "3" } };
		const [p] = deriveParams("Retry {{n}} times", meta);
		expect(p.meta.type).toBe("number");
		expect(p.meta.defaultValue).toBe("3");
	});

	it("ignores braces in prose that do not name a parameter", () => {
		// A body is natural language; stray braces must not mint parameters.
		expect(deriveParams("Use {{ note the spacing }} carefully")).toEqual([]);
		expect(deriveParams("A single {brace} is text")).toEqual([]);
	});

	it("does not read an escaped {{ as the start of a placeholder", () => {
		expect(deriveParams("Literal {{{{braces}} here")).toEqual([]);
	});

	it("reports metadata no placeholder refers to as orphaned, not as an error", () => {
		const meta: ParamMetaMap = {
			gone: { type: "text" },
			here: { type: "text" },
		};
		expect(orphanedParamMeta("Only {{here}}", meta)).toEqual(["gone"]);
	});
});

describe("stripControlChars", () => {
	it("neuters a bracketed-paste breakout in a parameter value", () => {
		// The fileDrop.ts injection arriving through a different door: a value
		// pasted from a web page or an Agent's own output can close bracketed
		// paste early, and the newline then submits whatever follows.
		const hostile = "ok\u001b[201~\nrm -rf /";
		const safe = stripControlChars(hostile);
		expect(safe).not.toContain("\u001b");
		expect(safe).not.toContain("\n");
		expect(safe).toBe("ok[201~rm -rf /");
	});

	it("strips C0, DEL and C1 but leaves ordinary text alone", () => {
		expect(stripControlChars("a\u0000b\u0007c\u007Fd\u009Ee")).toBe("abcde");
		expect(stripControlChars("Émil — ok/fine_123")).toBe("Émil — ok/fine_123");
	});
});

describe("resolveBody", () => {
	it("substitutes values into the body", () => {
		const out = resolveBody(
			"Fix {{file}}",
			{ file: { type: "text" } },
			{
				file: "src/app.ts",
			},
		);
		expect(out).toBe("Fix src/app.ts");
	});

	it("sanitises interpolated values", () => {
		const out = resolveBody(
			"Say {{x}}",
			{ x: { type: "text" } },
			{
				x: "hi\u001b[201~\nevil",
			},
		);
		expect(out).not.toContain("\u001b");
		expect(out).not.toContain("\n");
	});

	it("does NOT strip the body — its newlines are the point", () => {
		// Load-bearing asymmetry. The body is author-written; a numbered list of
		// instructions is a legitimate prompt. Do not "fix" this.
		const body = "Do this:\n1. one\n2. two";
		expect(resolveBody(body, {}, {})).toBe(body);
		expect(resolveBody(body, {}, {})).toContain("\n");
	});

	it("leaves a placeholder written out when no value was supplied", () => {
		// Every parameter is required, so arriving here means something upstream
		// is wrong. Showing {{file}} surfaces it; substituting "" would send a
		// sentence with a hole in it to a live Agent.
		expect(resolveBody("Fix {{file}}", { file: { type: "text" } }, {})).toBe(
			"Fix {{file}}",
		);
	});

	it("unescapes {{{{ to a literal {{", () => {
		expect(resolveBody("Literal {{{{x}} stays", {}, {})).toBe(
			"Literal {{x}} stays",
		);
	});

	it("does not substitute into an escaped placeholder", () => {
		const out = resolveBody(
			"{{{{name}} and {{name}}",
			{ name: { type: "text" } },
			{
				name: "VALUE",
			},
		);
		expect(out).toBe("{{name}} and VALUE");
	});
});

describe("resolveValue", () => {
	it("resolves a toggle to the author's own text, never true/false", () => {
		const meta = {
			type: "toggle" as const,
			onText: "Be exhaustive.",
			offText: "Keep it brief.",
		};
		expect(resolveValue(meta, true)).toBe("Be exhaustive.");
		expect(resolveValue(meta, false)).toBe("Keep it brief.");
	});

	it("resolves an off toggle with no offText to nothing", () => {
		expect(resolveValue({ type: "toggle", onText: "x" }, false)).toBe("");
	});

	it("joins attachment paths with spaces, as a multi-file File drop does", () => {
		expect(
			resolveValue({ type: "attachment", multiple: true }, [
				"/tmp/a.png",
				"/tmp/b.png",
			]),
		).toBe("/tmp/a.png /tmp/b.png");
	});

	it("sanitises attachment paths too", () => {
		expect(
			resolveValue({ type: "attachment" }, ["/tmp/ev\u001b[201~il.png"]),
		).toBe("/tmp/ev[201~il.png");
	});
});

describe("initialValues", () => {
	it("pre-fills authored defaults", () => {
		const values = initialValues("{{a}} {{b}}", {
			a: { type: "text", defaultValue: "hello" },
			b: { type: "text" },
		});
		expect(values).toEqual({ a: "hello", b: "" });
	});

	it("starts a toggle from its default and an attachment empty", () => {
		const values = initialValues("{{t}} {{f}}", {
			t: { type: "toggle", defaultValue: "true" },
			f: { type: "attachment" },
		});
		expect(values.t).toBe(true);
		expect(values.f).toEqual([]);
	});
});

describe("allFilled", () => {
	it("requires every parameter", () => {
		const params: ParamMetaMap = { a: { type: "text" }, b: { type: "text" } };
		expect(allFilled("{{a}} {{b}}", params, { a: "x", b: "" })).toBe(false);
		expect(allFilled("{{a}} {{b}}", params, { a: "x", b: "y" })).toBe(true);
	});

	it("treats whitespace as unfilled", () => {
		expect(allFilled("{{a}}", { a: { type: "text" } }, { a: "   " })).toBe(
			false,
		);
	});

	it("treats a toggle as always filled — both states are meaningful", () => {
		expect(allFilled("{{t}}", { t: { type: "toggle" } }, { t: false })).toBe(
			true,
		);
	});

	it("requires a number to actually be a number", () => {
		const params: ParamMetaMap = { n: { type: "number" } };
		expect(allFilled("{{n}}", params, { n: "abc" })).toBe(false);
		expect(allFilled("{{n}}", params, { n: "42" })).toBe(true);
	});

	it("requires at least one file for an attachment", () => {
		const params: ParamMetaMap = { f: { type: "attachment" } };
		expect(allFilled("{{f}}", params, { f: [] })).toBe(false);
		expect(allFilled("{{f}}", params, { f: ["/tmp/a.png"] })).toBe(true);
	});
});

describe("optional parameters", () => {
	it("treats an absent required flag as required", () => {
		// Actions authored before the flag existed keep their behaviour.
		expect(isRequired({ type: "text" })).toBe(true);
		expect(isRequired({ type: "text", required: true })).toBe(true);
		expect(isRequired({ type: "text", required: false })).toBe(false);
	});

	it("never requires a toggle — both its states are meaningful", () => {
		expect(isRequired({ type: "toggle" })).toBe(false);
		expect(isRequired({ type: "toggle", required: true })).toBe(false);
	});

	it("lets an action fire with an optional field left empty", () => {
		const params: ParamMetaMap = {
			a: { type: "text" },
			b: { type: "text", required: false },
		};
		expect(allFilled("{{a}} {{b}}", params, { a: "x", b: "" })).toBe(true);
		expect(allFilled("{{a}} {{b}}", params, { a: "", b: "" })).toBe(false);
	});

	it("erases an omitted optional placeholder with the gap around it", () => {
		// Substituting "" alone would leave "Review src/app.ts  today".
		const out = resolveBody(
			"Review {{file}} {{focus}} today",
			{ file: { type: "text" }, focus: { type: "text", required: false } },
			{ file: "src/app.ts", focus: "" },
		);
		expect(out).toBe("Review src/app.ts today");
	});

	it("drops a line that held nothing but an omitted optional placeholder", () => {
		const out = resolveBody(
			"Write a test for {{target}}.\n\n{{extra}}\n\nThanks.",
			{ target: { type: "text" }, extra: { type: "text", required: false } },
			{ target: "parse()", extra: "" },
		);
		expect(out).toBe("Write a test for parse().\n\n\nThanks.");
		expect(out).not.toContain("{{extra}}");
	});

	it("keeps an optional placeholder that WAS filled", () => {
		const out = resolveBody(
			"Review {{file}} {{focus}}",
			{ file: { type: "text" }, focus: { type: "text", required: false } },
			{ file: "a.ts", focus: "for races" },
		);
		expect(out).toBe("Review a.ts for races");
	});

	it("still leaves a required placeholder written out when unsupplied", () => {
		// A required field cannot legitimately arrive empty, so showing it
		// surfaces the bug rather than hiding it behind an empty string.
		expect(
			resolveBody("Fix {{file}}", { file: { type: "text" } }, { file: "" }),
		).toBe("Fix ");
	});
});

describe("canFire", () => {
	it("refuses while the Agent is Waiting", () => {
		// A permission prompt has redefined what keystrokes mean: the paste would
		// answer a question the user never read.
		expect(canFire("waiting")).toBe(false);
	});

	it("allows while Working — queuing a follow-up is a real workflow", () => {
		expect(canFire("active")).toBe(true);
	});

	it("allows in every other state", () => {
		expect(canFire("idle")).toBe(true);
		expect(canFire("ready")).toBe(true);
		expect(canFire("error")).toBe(true);
		expect(canFire(undefined)).toBe(true);
	});
});

describe("isInScope", () => {
	it("offers an all-scoped action to any Agent, including an unresolved one", () => {
		expect(isInScope({ kind: "all" }, "claude-code")).toBe(true);
		expect(isInScope({ kind: "all" }, undefined)).toBe(true);
	});

	it("offers a set-scoped action only to its Agents", () => {
		const scope = { kind: "set" as const, agentIds: ["claude-code", "codex"] };
		expect(isInScope(scope, "claude-code")).toBe(true);
		expect(isInScope(scope, "aider")).toBe(false);
	});

	it("withholds a set-scoped action while the Agent id is unresolved", () => {
		expect(
			isInScope({ kind: "set", agentIds: ["claude-code"] }, undefined),
		).toBe(false);
	});

	it("never offers an emptied scope set", () => {
		// Its only Agent was deleted. The action is kept — deleting is the user's
		// call — but it is never rendered.
		expect(isInScope({ kind: "set", agentIds: [] }, "claude-code")).toBe(false);
	});
});

describe("actionsForPane", () => {
	const scoped = action({
		id: "s",
		name: "Scoped",
		position: 5,
		scope: { kind: "set", agentIds: ["claude-code"] },
	});
	const global = action({ id: "g", name: "Global", position: 1 });

	it("puts agent-scoped actions ahead of global ones", () => {
		const out = actionsForPane([global, scoped], "claude-code", {
			barOnly: true,
		});
		expect(out.map((a) => a.id)).toEqual(["s", "g"]);
	});

	it("shows global-only while the Agent id is unresolved", () => {
		// The auto-launch path marks a PTY as an Agent knowing only the command
		// string; the id is backfilled later. A usable bar beats no bar.
		const out = actionsForPane([global, scoped], undefined, { barOnly: true });
		expect(out.map((a) => a.id)).toEqual(["g"]);
	});

	it("honours Show in bar only when barOnly is set", () => {
		const hidden = action({ id: "h", showInBar: false, position: 2 });
		expect(
			actionsForPane([global, hidden], "claude-code", { barOnly: true }).map(
				(a) => a.id,
			),
		).toEqual(["g"]);
		// The palette ignores the flag.
		expect(
			actionsForPane([global, hidden], "claude-code", { barOnly: false }).map(
				(a) => a.id,
			),
		).toEqual(["g", "h"]);
	});

	it("sorts within each group by authored position", () => {
		const a = action({ id: "a", position: 3 });
		const b = action({ id: "b", position: 0 });
		expect(
			actionsForPane([a, b], "claude-code", { barOnly: true }).map((x) => x.id),
		).toEqual(["b", "a"]);
	});

	it("returns nothing when no action is in scope", () => {
		// The caller renders no bar at all in this case — not an empty bar.
		expect(actionsForPane([scoped], "aider", { barOnly: true })).toEqual([]);
	});
});

describe("positionNumber", () => {
	it("numbers the first nine and no more", () => {
		expect(positionNumber(0)).toBe(1);
		expect(positionNumber(8)).toBe(9);
		expect(positionNumber(9)).toBeNull();
	});
});

describe("buttonLabel", () => {
	it("appends an ellipsis when the action will ask for something", () => {
		// The macOS menu convention. It matters here because a plain click
		// otherwise submits straight to the Agent.
		expect(buttonLabel(action({ body: "Fix {{file}}" }))).toBe("Review…");
	});

	it("leaves a parameterless action bare", () => {
		expect(buttonLabel(action({ body: "/review" }))).toBe("Review");
	});
});
