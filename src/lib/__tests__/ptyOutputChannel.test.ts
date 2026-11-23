import { beforeEach, describe, expect, it, vi } from "vitest";

const channels: Array<{ onmessage: (m: ArrayBuffer) => void }> = [];
const invoke = vi.fn((_cmd: string, _args?: unknown) => Promise.resolve());

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
	Channel: class {
		onmessage: (m: ArrayBuffer) => void = () => {};
		constructor() {
			channels.push(this);
		}
	},
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(() => Promise.resolve(() => {})),
	emit: vi.fn(() => Promise.resolve()),
}));

function frame(ptyId: string, data: number[]): ArrayBuffer {
	const id = [...ptyId].map((c) => c.charCodeAt(0));
	return new Uint8Array([id.length, ...id, ...data]).buffer;
}

describe("PTY output channel", () => {
	beforeEach(() => {
		vi.resetModules();
		channels.length = 0;
		invoke.mockClear();
	});

	it("parses a frame back into its pty id and bytes", async () => {
		const { parsePtyOutputFrame } = await import("../ipc");
		expect(parsePtyOutputFrame(frame("p-1", [104, 105]))).toEqual({
			ptyId: "p-1",
			data: new Uint8Array([104, 105]),
		});
		expect(parsePtyOutputFrame(new Uint8Array([5, 1]))).toBeNull();
		expect(parsePtyOutputFrame(new Uint8Array([]))).toBeNull();
	});

	it("opens one channel per Window and routes frames by pty id", async () => {
		const { pty } = await import("../ipc");
		const a: number[][] = [];
		const b: number[][] = [];
		const offA = await pty.onOutput("a", (d) => a.push([...d]));
		await pty.onOutput("b", (d) => b.push([...d]));
		expect(channels).toHaveLength(1);
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke.mock.calls[0][0]).toBe("pty_output_subscribe");

		channels[0].onmessage(frame("a", [1]));
		channels[0].onmessage(frame("b", [2]));
		channels[0].onmessage(frame("c", [3]));
		expect(a).toEqual([[1]]);
		expect(b).toEqual([[2]]);

		offA();
		channels[0].onmessage(frame("a", [4]));
		expect(a).toEqual([[1]]);
	});

	it("retries the subscription after a failure", async () => {
		invoke.mockImplementationOnce(() => Promise.reject(new Error("no")));
		const { pty } = await import("../ipc");
		await expect(pty.onOutput("a", () => {})).rejects.toThrow("no");
		await pty.onOutput("a", () => {});
		expect(invoke).toHaveBeenCalledTimes(2);
	});
});
