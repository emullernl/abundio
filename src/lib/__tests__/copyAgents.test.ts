import { describe, expect, it } from "vitest";
import { copyableAgents, copyOf } from "../copyAgents";
import type { CodingAgent } from "../types";

const a = (
	id: string,
	name: string,
	command: string,
	builtin = false,
): CodingAgent => ({
	id,
	name,
	command,
	builtin,
	enabled: false,
});

describe("Copy from…", () => {
	it("offers the custom Agents the Host lacks, never a built-in", () => {
		const source = [
			a("claude", "Claude Code", "claude", true),
			a("c1", "Mine", "my-agent"),
			a("c2", "Other", "other"),
		];
		const have = [a("x", "Other", "other")];
		expect(copyableAgents(source, have).map((x) => x.id)).toEqual(["c1"]);
	});
	it("gives a copy its own id, switched on", () => {
		const c = copyOf(a("c1", "Mine", "my-agent"));
		expect(c.id).not.toBe("c1");
		expect(c).toMatchObject({
			name: "Mine",
			command: "my-agent",
			enabled: true,
		});
	});
});
