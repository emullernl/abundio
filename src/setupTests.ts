import { vi } from "vitest";

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
}));

// Mock @tauri-apps/api/event
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(() => Promise.resolve(() => {})),
	emit: vi.fn(),
}));

// Mock crypto.randomUUID if not available
if (!globalThis.crypto?.randomUUID) {
	let counter = 0;
	Object.defineProperty(globalThis, "crypto", {
		value: {
			...globalThis.crypto,
			randomUUID: () => `test-uuid-${++counter}`,
		},
	});
}
