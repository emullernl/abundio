import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import fixtures from "../../__tests__/fixtures/screenRead.json";
import { readBuffer } from "../readBuffer";

/** The same cases `src-tauri/src/screen.rs` runs against its emulator, so
 *  Rust and xterm.js read a pane the same way (ADR-0063).
 *
 *  Two known differences. Clearing the screen (`ESC[2J`) moves its rows into
 *  scrollback in alacritty_terminal, as most terminals do, but only erases
 *  them in xterm.js (its `scrollOnEraseInDisplay` is off), so a full read can
 *  differ after a clear; the fixtures read the screen there. And, ignored
 *  here: xterm.js keeps trailing spaces a
 *  program wrote (`"a   "`), while alacritty_terminal cannot tell a written
 *  space from an empty cell and Rust trims both. Rust is the reader Agent
 *  control uses, and trimmed is what an Agent wants. */
describe("reading a pane: shared fixtures (xterm.js)", () => {
	for (const c of fixtures.cases) {
		it(c.name, async () => {
			const term = new Terminal({
				cols: c.cols,
				rows: c.rows,
				scrollback: c.scrollback,
				allowProposedApi: true,
			});
			await new Promise<void>((resolve) => term.write(c.input, resolve));
			const lines = readBuffer(term.buffer.active, term.rows, {
				lines: c.lines,
				visible: c.visible,
			});
			expect(lines.map((l) => l.trimEnd())).toEqual(c.expected);
			term.dispose();
		});
	}
});

describe("compareScreenReads", () => {
	it("agrees when only trailing spaces differ", async () => {
		const { compareScreenReads } = await import("../handleControlRequest");
		expect(compareScreenReads(["a   ", "b"], ["a", "b"])).toBeNull();
	});

	it("points at the first line that differs", async () => {
		const { compareScreenReads } = await import("../handleControlRequest");
		expect(compareScreenReads(["a", "b", "c"], ["a", "x"])).toEqual({
			firstDifferentLine: 1,
			xterm: ["a", "b", "c"],
			rust: ["a", "x"],
		});
	});
});
