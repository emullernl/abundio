import { describe, expect, it } from "vitest";
import { clearSpawnedBy } from "../../paneTree";
import type { CodingAgent, PaneNode } from "../../types";
import {
	autoDirection,
	cleanCommand,
	closeRefusal,
	layoutDirection,
	runRefusal,
	startArgv,
} from "../spawn";

const claude: CodingAgent = {
	id: "claude",
	name: "Claude Code",
	command: "claude",
	args: ["--verbose"],
	taskArgs: ["{prompt}"],
	builtin: true,
	enabled: true,
};
const plain: CodingAgent = {
	id: "mine",
	name: "Mine",
	command: "npx my-agent",
	builtin: false,
	enabled: true,
};
const off: CodingAgent = { ...plain, id: "off", enabled: false };
const agents = [claude, plain, off];

describe("split direction", () => {
	it("splits right when at least twice as wide as tall, else down", () => {
		expect(autoDirection(160, 40)).toBe("right");
		expect(autoDirection(80, 40)).toBe("right");
		expect(autoDirection(79, 40)).toBe("down");
		expect(autoDirection(80, 60)).toBe("down");
	});

	it("maps a side to the layout's split direction", () => {
		expect(layoutDirection("right")).toBe("vertical");
		expect(layoutDirection("down")).toBe("horizontal");
	});
});

describe("startArgv", () => {
	it("puts extra args after the Agent's own, and the prompt last as one element", () => {
		expect(
			startArgv(agents, "claude", "fix the build", ["--model", "x"]).argv,
		).toEqual(["claude", "--verbose", "--model", "x", "fix the build"]);
	});

	it("starts without a prompt, splitting a multi-word command", () => {
		expect(startArgv(agents, "mine", null, []).argv).toEqual([
			"npx",
			"my-agent",
		]);
	});

	it("refuses a prompt for an Agent that cannot take one", () => {
		expect(() => startArgv(agents, "mine", "hi", [])).toThrow(
			expect.objectContaining({ code: "unsupported" }),
		);
	});

	it("refuses an unknown or switched-off Agent, naming the ones on", () => {
		for (const kind of ["nope", "off"]) {
			try {
				startArgv(agents, kind, null, []);
				expect.unreachable();
			} catch (e) {
				expect(e).toMatchObject({ code: "not_found" });
				expect((e as Error).message).toContain("claude, mine");
			}
		}
	});

	it("keeps a prompt starting with - from reading as an option", () => {
		const argv = startArgv(agents, "claude", "-x please", []).argv;
		expect(argv[argv.length - 1].startsWith("-")).toBe(false);
	});
});

describe("runRefusal", () => {
	const ok = {
		mode: "shell" as const,
		exited: false,
		integrationSeen: true,
		shellCommandRunning: false,
	};

	it("allows an idle shell at its prompt", () => {
		expect(runRefusal(ok)).toBeNull();
	});

	it("refuses an Agent pane, a running command, an unknown shell and an exited one", () => {
		expect(runRefusal({ ...ok, mode: "agent" })?.code).toBe("busy");
		expect(runRefusal({ ...ok, shellCommandRunning: true })?.code).toBe("busy");
		expect(runRefusal({ ...ok, integrationSeen: false })?.code).toBe(
			"state_unknown",
		);
		expect(runRefusal({ ...ok, exited: true })?.code).toBe("not_found");
	});
});

describe("cleanCommand", () => {
	it("makes one line with no control characters", () => {
		expect(cleanCommand("ls -la\n rm -rf /\x1b[201~")).toBe(
			"ls -la  rm -rf / [201~",
		);
		expect(cleanCommand("  \r ")).toBe("");
	});
});

describe("closeRefusal", () => {
	it("allows only the owner, never on its own pane", () => {
		expect(closeRefusal("a", "a", "b")).toBeNull();
		expect(closeRefusal("c", "a", "b")?.code).toBe("not_owner");
		expect(closeRefusal(undefined, "a", "b")?.code).toBe("not_owner");
		expect(closeRefusal(undefined, "a", "a")?.code).toBe("not_owner");
	});
});

describe("clearSpawnedBy", () => {
	it("makes an owner's Spawned panes ordinary, leaving others alone", () => {
		const tree: PaneNode = {
			type: "split",
			id: "s",
			direction: "vertical",
			ratio: 0.5,
			first: { type: "terminal", id: "b", ptyId: "", spawnedBy: "a" },
			second: { type: "terminal", id: "c", ptyId: "", spawnedBy: "x" },
		};
		const out = clearSpawnedBy(tree, "a");
		expect(out).toMatchObject({
			first: { id: "b" },
			second: { spawnedBy: "x" },
		});
		expect((out as { first: object }).first).not.toHaveProperty("spawnedBy");
		expect(clearSpawnedBy(tree, "nobody")).toBe(tree);
	});
});
