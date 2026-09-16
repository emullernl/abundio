import { describe, expect, it, vi } from "vitest";

vi.mock("@uiw/react-markdown-preview", () => ({ default: () => null }));
vi.mock("@uiw/react-markdown-preview/markdown.css", () => ({}));
vi.mock("../../../styles/markdown.css", () => ({}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: () => Promise.resolve() }));
vi.mock("../../../lib/themes", () => ({
	applyTheme: vi.fn(),
	getTheme: () => ({
		variant: "dark",
		ui: {},
		terminal: { background: "#000" },
	}),
	themeList: () => [],
}));

import { isExternalHref } from "../ReleaseNotesMarkdown";

/**
 * Release-note Markdown arrives over the network, so what its links may ask the
 * OS to launch is a security boundary, not a nicety. `rehype-sanitize` already
 * strips `javascript:` — this narrows the rest.
 */
describe("isExternalHref", () => {
	it("allows the two protocols a release note actually uses", () => {
		expect(isExternalHref("https://github.com/emullernl/abundio")).toBe(true);
		expect(isExternalHref("http://example.test")).toBe(true);
	});

	it("is case-insensitive about the scheme", () => {
		expect(isExternalHref("HTTPS://example.test")).toBe(true);
		expect(isExternalHref("HtTp://example.test")).toBe(true);
	});

	it("refuses the other protocols rehype-sanitize permits", () => {
		// defaultSchema allows these six; only http(s) is meaningful here, and
		// the rest would be handed straight to an OS handler.
		expect(isExternalHref("mailto:someone@example.test")).toBe(false);
		expect(isExternalHref("xmpp:someone@example.test")).toBe(false);
		expect(isExternalHref("irc://example.test")).toBe(false);
		expect(isExternalHref("ircs://example.test")).toBe(false);
	});

	it("refuses what sanitization is supposed to have stripped already", () => {
		// Belt and braces: this should never reach us, but nothing here depends
		// on that being true.
		expect(isExternalHref("javascript:alert(1)")).toBe(false);
		expect(isExternalHref("file:///etc/passwd")).toBe(false);
		expect(isExternalHref("data:text/html,<script>")).toBe(false);
	});

	it("refuses a missing or relative href", () => {
		expect(isExternalHref(undefined)).toBe(false);
		expect(isExternalHref("")).toBe(false);
		expect(isExternalHref("/relative/path")).toBe(false);
		expect(isExternalHref("#anchor")).toBe(false);
	});

	it("is not fooled by a scheme-looking substring later in the string", () => {
		expect(isExternalHref("/redirect?to=https://example.test")).toBe(false);
	});
});
