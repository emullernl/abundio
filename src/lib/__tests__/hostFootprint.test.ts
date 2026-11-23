import { describe, expect, it } from "vitest";
import { hostFootprint } from "../hostFootprint";
import type { HostCheck } from "../ipc";

const check = (probe: Partial<HostCheck["probe"]>) =>
	({
		probe: {
			os: "Linux",
			arch: "x86_64",
			current: "3.1.0",
			running: true,
			...probe,
		},
		items: [],
		appVersion: "3.1.0",
	}) as unknown as HostCheck;

const text = (f: ReturnType<typeof hostFootprint>) =>
	f.sections
		.flatMap((s) => s.lines.map((l) => `${l.text} ${l.path ?? ""}`))
		.join("\n");

describe("hostFootprint (the ⓘ on a Host)", () => {
	it("describes a Linux Host's actual service and linger", () => {
		const f = hostFootprint(check({ service: "systemd", linger: true }));
		expect(f.unknown).toBe(false);
		expect(text(f)).toContain("~/.abundio-server/3.1.0/abundio-server");
		expect(text(f)).toContain("~/.config/systemd/user/abundio-server.service");
		expect(text(f)).toContain("Linger is on");
	});

	it("describes a Mac's LaunchAgent, and a Host with no service", () => {
		expect(
			text(hostFootprint(check({ os: "Darwin", service: "launchd" }))),
		).toContain("~/Library/LaunchAgents/dev.abundio.server.plist");
		expect(text(hostFootprint(check({ service: null })))).toContain(
			"No service. The server runs until the Host restarts.",
		);
	});

	it("says what Install would do when not checked, and always how to remove it", () => {
		const f = hostFootprint(null);
		expect(f.unknown).toBe(true);
		expect(text(f)).toContain("Install puts the server");
		expect(text(f)).toContain("Uninstall leaves the Agent hooks and the skill");
		expect(text(f)).toContain("Nothing is open to the network");
	});
});
