import { describe, expect, it } from "vitest";
import {
	hasTitleStatus,
	readTitle,
	readTitleStatus,
	titleStep,
} from "../agentTitleMap";

describe("readTitleStatus (Mistral Vibe)", () => {
	it("reads the focused-pane prefixes", () => {
		expect(readTitleStatus("vibe", ">> Fix the parser")).toBe("working");
		expect(readTitleStatus("vibe", "? Fix the parser")).toBe("waiting");
		expect(readTitleStatus("vibe", "Fix the parser")).toBe("none");
	});

	it("reads the blurred-pane suffixes", () => {
		// Abundio passes focus reports through, so background panes see these.
		expect(readTitleStatus("vibe", "Fix the parser - Action Required")).toBe(
			"waiting",
		);
		expect(readTitleStatus("vibe", "Fix the parser - Task Complete")).toBe(
			"none",
		);
	});

	it("needs the space after the prefix", () => {
		expect(readTitleStatus("vibe", ">>Fix")).toBe("none");
		expect(readTitleStatus("vibe", "?Why")).toBe("none");
	});

	it("is null for Agents without title rules", () => {
		expect(readTitleStatus("claude", ">> busy")).toBeNull();
		expect(readTitleStatus(undefined, ">> busy")).toBeNull();
		expect(hasTitleStatus("vibe")).toBe(true);
		expect(hasTitleStatus("claude")).toBe(false);
		expect(hasTitleStatus(undefined)).toBe(false);
	});
});

describe("readTitle", () => {
	it("only a prefix proves tab status is on", () => {
		expect(readTitle("vibe", ">> Fix")).toEqual({
			status: "working",
			live: true,
		});
		expect(readTitle("vibe", "? Fix")).toEqual({
			status: "waiting",
			live: true,
		});
		// Vibe writes the suffixes with tab status off too.
		expect(readTitle("vibe", "Fix - Action Required")).toEqual({
			status: "waiting",
			live: false,
		});
		expect(readTitle("vibe", "Fix")).toEqual({ status: "none", live: false });
		expect(readTitle("claude", ">> Fix")).toBeNull();
	});
});

describe("titleStep", () => {
	it("does nothing when the status is unchanged", () => {
		expect(titleStep("working", "working")).toEqual({
			dispatch: null,
			awaitTurnEnd: false,
		});
	});

	it("opens a Turn on Working from outside a Turn", () => {
		expect(titleStep(null, "working").dispatch).toEqual({
			status: "working",
			startsTurn: true,
		});
		expect(titleStep("none", "working").dispatch).toEqual({
			status: "working",
			startsTurn: true,
		});
	});

	it("resumes the same Turn after an answered prompt", () => {
		expect(titleStep("waiting", "working").dispatch).toEqual({
			status: "working",
			startsTurn: false,
		});
		expect(titleStep("working", "waiting").dispatch).toEqual({
			status: "waiting",
			startsTurn: false,
		});
	});

	it("resumes across a bare title that followed Waiting", () => {
		// `? t` → `t` → `>> t` inside the grace window.
		expect(titleStep("none", "working", "waiting").dispatch).toEqual({
			status: "working",
			startsTurn: false,
		});
		expect(titleStep("none", "working", "working").dispatch).toEqual({
			status: "working",
			startsTurn: true,
		});
	});

	it("awaits the Turn end when a busy title goes plain", () => {
		expect(titleStep("working", "none")).toEqual({
			dispatch: { status: "none", startsTurn: false },
			awaitTurnEnd: true,
		});
		expect(titleStep("waiting", "none").awaitTurnEnd).toBe(true);
	});

	it("ignores the Agent's first plain title", () => {
		expect(titleStep(null, "none")).toEqual({
			dispatch: null,
			awaitTurnEnd: false,
		});
	});
});
