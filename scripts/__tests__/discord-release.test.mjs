import { describe, expect, it } from "vitest";
import {
	buildPayload,
	DESCRIPTION_LIMIT,
	linkifyPrRefs,
	truncateNotes,
} from "../discord-release.mjs";

const REPO = "https://github.com/emullernl/abundio";
const URL = `${REPO}/releases/tag/v2.1.4`;

describe("linkifyPrRefs", () => {
	it("links bare PR references", () => {
		expect(linkifyPrRefs("Faster. (#227, #228)", REPO)).toBe(
			`Faster. ([#227](${REPO}/pull/227), [#228](${REPO}/pull/228))`,
		);
	});

	it("leaves code spans, existing links and anchors alone", () => {
		const text = "`#1` [#2](x) page#3 a/#4 &#5;";
		expect(linkifyPrRefs(text, REPO)).toBe(text);
	});

	it("does not touch headings", () => {
		expect(linkifyPrRefs("## 🐛 Bug Fixes", REPO)).toBe("## 🐛 Bug Fixes");
	});
});

describe("truncateNotes", () => {
	it("keeps notes that fit", () => {
		expect(truncateNotes("- one\n- two", URL)).toBe("- one\n- two");
	});

	it("cuts before the first item that does not fit and links the rest", () => {
		const notes = ["## ✨ New", "- aaaa", "- bbbb", `- ${"c".repeat(200)}`].join("\n");
		const suffix = `\n\n…[read the full notes](${URL})`;
		const limit = "## ✨ New\n- aaaa\n- bbbb".length + suffix.length;
		expect(truncateNotes(notes, URL, limit)).toBe(
			`## ✨ New\n- aaaa\n- bbbb${suffix}`,
		);
	});

	it("never splits a multi-line item", () => {
		const notes = `- one\n- two starts\n  and continues\n- ${"t".repeat(200)}`;
		const suffix = `\n\n…[read the full notes](${URL})`;
		const limit = "- one\n- two starts".length + suffix.length;
		expect(truncateNotes(notes, URL, limit)).toBe(`- one${suffix}`);
	});

	it("drops a heading left dangling at the cut", () => {
		const notes = `- one\n\n## 🐛 Bug Fixes\n\n- ${"f".repeat(200)}`;
		const suffix = `\n\n…[read the full notes](${URL})`;
		const limit = "- one\n\n## 🐛 Bug Fixes\n".length + suffix.length;
		expect(truncateNotes(notes, URL, limit)).toBe(`- one${suffix}`);
	});

	it("hard-cuts when not even the first item fits", () => {
		const out = truncateNotes(`- ${"x".repeat(5000)}`, URL);
		expect(out.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
		expect(out.endsWith(`(${URL})`)).toBe(true);
	});

	it("always fits Discord's limit", () => {
		const notes = Array.from({ length: 300 }, (_, i) => `- item ${i}`).join(
			"\n",
		);
		expect(truncateNotes(notes, URL).length).toBeLessThanOrEqual(
			DESCRIPTION_LIMIT,
		);
	});
});

describe("buildPayload", () => {
	const release = {
		name: "Abundio v2.1.4",
		tag_name: "v2.1.4",
		html_url: URL,
		body: "- **Faster.** Yes. (#227)\n",
	};

	it("builds one embed linking to the release", () => {
		const { embeds } = buildPayload(release, REPO);
		expect(embeds).toHaveLength(1);
		expect(embeds[0].title).toBe("Abundio v2.1.4");
		expect(embeds[0].url).toBe(URL);
		expect(embeds[0].description).toBe(
			`- **Faster.** Yes. ([#227](${REPO}/pull/227))`,
		);
	});

	it("never pings", () => {
		const payload = buildPayload({ ...release, body: "@everyone" }, REPO);
		expect(payload.allowed_mentions).toEqual({ parse: [] });
	});

	it("falls back to the tag and a placeholder body", () => {
		const { embeds } = buildPayload(
			{ tag_name: "v9.9.9", html_url: URL, body: null },
			REPO,
		);
		expect(embeds[0].title).toBe("v9.9.9");
		expect(embeds[0].description).toBe("No release notes.");
	});
});
