import type { ITerminalOptions } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";

// terminalManager pulls in xterm, the WebGL addon and Tauri IPC at import time;
// none of that is needed to check which option keys get written.
vi.mock("../ipc", () => ({
	pty: { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), spawn: vi.fn() },
	listen: vi.fn(async () => () => {}),
	invoke: vi.fn(),
}));

import { applyDerivedThemeOptions } from "../terminalManager";
import { themes } from "../themes";
import { terminalThemeFor } from "../themeUtils";

describe("applyDerivedThemeOptions", () => {
	// The drift guard. `minimumContrastRatio` was once set at Terminal
	// construction and never added to the live-switch path — harmless while it
	// was a constant, a bug the moment it varies by theme. A test on
	// terminalThemeFor alone stays green through exactly that mistake, because
	// the mistake is at the call site: assigning `theme` and `fontWeight` by hand
	// and forgetting the third. See ADR-0035.
	it("writes every derived option, not just the palette", () => {
		const options: Partial<ITerminalOptions> = {};
		const derived = terminalThemeFor(themes.solarizedDark.terminal);
		applyDerivedThemeOptions(options, derived);
		expect(Object.keys(options).sort()).toEqual(Object.keys(derived).sort());
	});

	it("carries a theme switch's floor across, not the previous theme's", () => {
		const options: Partial<ITerminalOptions> = {};
		applyDerivedThemeOptions(
			options,
			terminalThemeFor(themes.solarizedDark.terminal),
		);
		const lowFloor = options.minimumContrastRatio;
		applyDerivedThemeOptions(options, terminalThemeFor(themes.vesper.terminal));
		expect(lowFloor).toBeLessThan(4.5);
		expect(options.minimumContrastRatio).toBe(4.5);
	});
});
