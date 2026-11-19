import { describe, expect, it } from "vitest";
import { BUILTIN_AGENTS, matchTitleToAgent } from "../agents";
import { type ShellCommand, ShellIntegrationParser } from "../shellIntegration";
import type { CodingAgent } from "../types";
import fixture from "./fixtures/shellIntegration.json";

/**
 * The Window's shell-integration reader and Agent matcher, on cases Rust's
 * `shell_integration.rs` replays and must match (docs/plans/remote-hosts.md
 * phase 6d-4): output streams cut into reads every which way, and typed
 * command lines against Agent lists.
 *
 * Regenerate after a change:
 * `UPDATE_SHELL_INTEGRATION=1 npx vitest run src/lib/__tests__/shellIntegrationParity.test.ts`
 */

const NODE_FS = "node:fs";
const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

interface AgentCommand {
	id: string;
	command: string;
	enabled: boolean;
}

interface Fixture {
	builtins: AgentCommand[];
	parse: { chunks: string[]; expected: ShellCommand[][] }[];
	matches: { text: string; agents: AgentCommand[]; expected: string | null }[];
}

const SEGMENTS = [
	"plain output\r\n",
	"é and more",
	"\x1b]7770;command_start;claude --model opus\x07",
	"\x1b]7770;command_start\x07",
	"\x1b]7770;command_start;\x07",
	"\x1b]7770;command_end;0\x07",
	"\x1b]7770;command_end;130\x07",
	"\x1b]7770;command_end;\x07",
	"\x1b]7770;command_end; -2x\x07",
	"\x1b]7770;cwd;/tmp/dé j\x07",
	"\x1b]7770;cwd;\x07",
	"\x1b]7770;unknown;x\x07",
	"\x1b]0;a title\x07",
	"\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\",
	"\x1b[31mred\x1b[0m",
	"\x1b",
	"\x1b]77",
	"\x1b]7771;x\x07",
];

/** A small deterministic generator, so the fixture never churns. */
function rng(seed: number): () => number {
	let x = seed;
	return () => {
		x = (x * 1103515245 + 12345) & 0x7fffffff;
		return x / 0x7fffffff;
	};
}

function parseCases(): Fixture["parse"] {
	const next = rng(77);
	const streams: string[] = [];
	for (let n = 0; n < 250; n++) {
		let s = "";
		const parts = 1 + Math.floor(next() * 8);
		for (let i = 0; i < parts; i++) {
			s += SEGMENTS[Math.floor(next() * SEGMENTS.length)];
		}
		streams.push(s);
	}
	// A sequence that never ends, then a real one.
	const long = `\x1b]7770;cwd;${"x".repeat(17000)}`;
	streams.push(`${long}\x1b]7770;command_end;1\x07`);
	streams.push(`\x1b]7770;command_start;${"y".repeat(9000)}\x07`);

	return streams.map((stream) => {
		const chunks: string[] = [];
		let rest = stream;
		while (rest.length > 0) {
			const cut = 1 + Math.floor(next() * Math.min(rest.length, 40));
			const take = next() < 0.2 ? rest.length : cut;
			chunks.push(rest.slice(0, take));
			rest = rest.slice(take);
		}
		const parser = new ShellIntegrationParser();
		const expected = chunks.map((c) => parser.parse(encode(c)).commands);
		return JSON.parse(JSON.stringify({ chunks, expected }));
	});
}

function agent(id: string, command: string, enabled = true): AgentCommand {
	return { id, command, enabled };
}

const BUILTINS: AgentCommand[] = BUILTIN_AGENTS.map((a) =>
	agent(a.id, a.command, a.enabled),
);

function matchCases(): Fixture["matches"] {
	const lists: AgentCommand[][] = [
		BUILTINS,
		[agent("claude", "claude", false), ...BUILTINS.slice(1)],
		[
			agent("mine", "My-AI"),
			agent("cpp", "c++"),
			agent("aa", "aa"),
			...BUILTINS,
		],
		[agent("empty", ""), ...BUILTINS],
	];
	const texts = [
		"",
		"claude",
		" claude",
		"npx claude --model opus",
		"/usr/local/bin/claude",
		"c:\\bin\\claude",
		"claudette",
		"my-claude",
		"CLAUDE",
		"echo claude",
		"claude\tx",
		"claude.exe",
		"vibe",
		"vibes",
		"sudo vibe --resume",
		"my-ai run",
		"run MY-AI",
		"c++ main.cpp",
		"gcc++",
		"aaa aa",
		"baa aa",
		"x aaaa",
		"opencode && claude",
		"cd /work/claude",
		"grok\u00a0x",
	];
	const out: Fixture["matches"] = [];
	for (const agents of lists) {
		for (const text of texts) {
			const matched = matchTitleToAgent(
				text,
				agents.map((a) => ({ ...a, name: a.id }) as CodingAgent),
			);
			out.push({ text, agents, expected: matched?.id ?? null });
		}
	}
	return out;
}

describe("shell integration parity", () => {
	const generated: Fixture = {
		builtins: BUILTINS,
		parse: parseCases(),
		matches: matchCases(),
	};

	it("covers every kind of report, and agents both matched and not", () => {
		const kinds = new Set(
			generated.parse.flatMap((c) => c.expected.flat().map((e) => e.type)),
		);
		expect(kinds).toEqual(
			new Set(["command_start", "command_end", "cwd_change"]),
		);
		const ids = new Set(generated.matches.map((m) => m.expected));
		for (const id of [null, "claude", "vibe", "mine", "cpp", "aa"]) {
			expect(ids).toContain(id);
		}
	});

	it("matches the fixture Rust replays", async () => {
		const proc = (
			globalThis as {
				process?: { env?: Record<string, string>; cwd(): string };
			}
		).process;
		if (proc?.env?.UPDATE_SHELL_INTEGRATION) {
			const fs = (await import(/* @vite-ignore */ NODE_FS)) as {
				writeFileSync(path: string, data: string): void;
			};
			fs.writeFileSync(
				`${proc.cwd()}/src/lib/__tests__/fixtures/shellIntegration.json`,
				`${JSON.stringify({ _comment: "Generated by shellIntegrationParity.test.ts; replayed by shell_integration.rs.", ...generated })}\n`,
			);
			return;
		}
		expect(generated).toEqual({
			builtins: (fixture as unknown as Fixture).builtins,
			parse: (fixture as unknown as Fixture).parse,
			matches: (fixture as unknown as Fixture).matches,
		});
	});
});
