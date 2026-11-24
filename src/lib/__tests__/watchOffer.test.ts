import { describe, expect, it } from "vitest";
import {
	addOffer,
	closeOffersFor,
	paneOfPty,
	removeOffer,
	watchOfferCopy,
} from "../watchOffer";

describe("paneOfPty", () => {
	it("finds the pane running a PTY", () => {
		expect(paneOfPty({ a: "p1", b: "p2" }, "p2")).toBe("b");
		expect(paneOfPty({ a: "p1" }, "p9")).toBeUndefined();
	});
});

describe("addOffer", () => {
	it("adds an offer, and keeps the same one as it is", () => {
		const one = addOffer({}, "a", { agentId: "codex", kind: "watch" });
		expect(one).toEqual({ a: { agentId: "codex", kind: "watch" } });
		expect(addOffer(one, "a", { agentId: "codex", kind: "watch" })).toBe(one);
	});

	it("never lets a watch offer replace a restart offer for the same Agent", () => {
		const r = addOffer({}, "a", { agentId: "codex", kind: "restart" });
		expect(addOffer(r, "a", { agentId: "codex", kind: "watch" })).toBe(r);
	});

	it("lets a restart offer replace a watch offer", () => {
		const w = addOffer({}, "a", { agentId: "codex", kind: "watch" });
		expect(addOffer(w, "a", { agentId: "codex", kind: "restart" }).a.kind).toBe(
			"restart",
		);
	});

	it("shows the latest Agent typed in a pane", () => {
		const w = addOffer({}, "a", { agentId: "codex", kind: "restart" });
		expect(addOffer(w, "a", { agentId: "gemini", kind: "watch" }).a).toEqual({
			agentId: "gemini",
			kind: "watch",
		});
	});
});

describe("removeOffer", () => {
	it("removes one pane's offer", () => {
		const o = { a: { agentId: "codex", kind: "watch" as const } };
		expect(removeOffer(o, "a")).toEqual({});
		expect(removeOffer(o, "b")).toBe(o);
	});
});

describe("closeOffersFor", () => {
	const offers = {
		a: { agentId: "codex", kind: "watch" as const },
		b: { agentId: "codex", kind: "watch" as const },
		c: { agentId: "gemini", kind: "watch" as const },
		d: { agentId: "codex", kind: "restart" as const },
	};

	it("closes the Agent's watch offers on Not now or Never", () => {
		expect(closeOffersFor(offers, "codex", false)).toEqual({
			c: offers.c,
			d: offers.d,
		});
	});

	it("turns them into restart offers on Enable", () => {
		expect(closeOffersFor(offers, "codex", true)).toEqual({
			a: { agentId: "codex", kind: "restart" },
			b: { agentId: "codex", kind: "restart" },
			c: offers.c,
			d: offers.d,
		});
	});

	it("leaves the panes of other Hosts alone", () => {
		expect(closeOffersFor(offers, "codex", true, (p) => p !== "b")).toEqual({
			a: { agentId: "codex", kind: "restart" },
			b: offers.b,
			c: offers.c,
			d: offers.d,
		});
	});

	it("changes nothing for an Agent with no watch offer", () => {
		expect(closeOffersFor(offers, "qwen", true)).toBe(offers);
	});
});

describe("watchOfferCopy", () => {
	it("offers status tracking when hooks are on", () => {
		const c = watchOfferCopy("watch", "Codex", true);
		expect(c.message).toContain("status tracking");
		expect(c.actions.map((a) => a.action)).toEqual([
			"enable-restart",
			"enable",
			"later",
			"never",
		]);
		expect(c.actions[0].label).toContain("new session");
	});

	it("leaves status tracking out when hooks are off", () => {
		const c = watchOfferCopy("watch", "Codex", false);
		expect(c.message).not.toContain("status tracking");
		expect(c.message).toContain("Add it to Abundio's agents");
	});

	it("claims no status tracking in a restart offer with hooks off", () => {
		const c = watchOfferCopy("restart", "Codex", false);
		expect(c.message).not.toContain("tracking");
		expect(c.actions.map((a) => a.action)).toEqual(["restart"]);
	});

	it("offers only a restart once the hooks are written", () => {
		const c = watchOfferCopy("restart", "Codex", true);
		expect(c.actions.map((a) => a.action)).toEqual(["restart"]);
		expect(c.actions[0].label).toContain("new session");
	});
});
