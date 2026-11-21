import { describe, expect, it } from "vitest";
import { resyncSnapshot } from "../ptyResync";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("resyncSnapshot", () => {
	it("finds the snapshot after the mark", () => {
		const out = resyncSnapshot(bytes("\x1b]7771;resync\x07hello"));
		expect(new TextDecoder().decode(out ?? new Uint8Array())).toBe("hello");
	});
	it("leaves ordinary output alone", () => {
		expect(resyncSnapshot(bytes("hello"))).toBeNull();
		expect(resyncSnapshot(bytes("\x1b]7770;A\x07"))).toBeNull();
		expect(resyncSnapshot(bytes("x\x1b]7771;resync\x07"))).toBeNull();
	});
});
