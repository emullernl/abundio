import { beforeEach, describe, expect, it } from "vitest";
import { HOST_API_COMMANDS } from "../hostApiCommands";
import {
	HOST_ROUTES,
	mergeAnswers,
	resetRouting,
	routeCall,
	sentByOwnerOf,
	setJoinedWorkspace,
	setOwnHost,
	setRoutingLookups,
} from "../hostRouting";

// This Window's own Workspace "mine" (/Users/me/app) and a joined one
// "theirs" on Host "box" (/home/dev/app), with a Tab, a pane and a PTY each.
function joinOne() {
	setRoutingLookups({
		workspaceOfTab: (id) => ({ "t-mine": "mine", "t-theirs": "theirs" })[id],
		workspaceOfPane: (id) => ({ "p-mine": "mine", "p-theirs": "theirs" })[id],
		workspaceOfPty: (id) => ({ "y-mine": "mine", "y-theirs": "theirs" })[id],
		workspaceOfPath: (p) =>
			p.startsWith("/home/dev/app")
				? "theirs"
				: p.startsWith("/Users/me/app")
					? "mine"
					: undefined,
	});
	setJoinedWorkspace("theirs", "box");
}

const hosts = (command: string, args: Record<string, unknown>) =>
	routeCall(command, args).map((c) => c.host);

describe("hostRouting", () => {
	beforeEach(() => resetRouting());

	it("has a route for every host command", () => {
		const missing = [...HOST_API_COMMANDS].filter((c) => !(c in HOST_ROUTES));
		expect(missing).toEqual([]);
		const extra = Object.keys(HOST_ROUTES).filter(
			(c) => !HOST_API_COMMANDS.has(c),
		);
		expect(extra).toEqual([]);
	});

	it("changes nothing while nothing is joined", () => {
		const args = { ptyId: "y-theirs", data: "x" };
		expect(routeCall("pty_write", args)).toEqual([{ host: null, args }]);
	});

	it("sends a call about a joined Workspace, or anything in it, to its Host", () => {
		joinOne();
		expect(hosts("pty_write", { ptyId: "y-theirs" })).toEqual(["box"]);
		expect(hosts("pty_write", { ptyId: "y-mine" })).toEqual([null]);
		expect(hosts("layout_apply", { tabId: "t-theirs" })).toEqual(["box"]);
		expect(hosts("pty_read_log", { logId: "p-theirs" })).toEqual(["box"]);
		expect(hosts("note_set", { workspaceId: "theirs" })).toEqual(["box"]);
		expect(hosts("workspace_delete", { id: "theirs" })).toEqual(["box"]);
		expect(hosts("fs_read_file", { path: "/home/dev/app/README.md" })).toEqual([
			"box",
		]);
		expect(hosts("git_branch_info", { cwd: "/Users/me/app" })).toEqual([null]);
		// A Profile id means the Window's own backend's Profile, always: every
		// database seeds the same Default id (calls about a Joined profile
		// name its Host).
		expect(hosts("workspace_list", { profileId: "their-profile" })).toEqual([
			null,
		]);
		expect(
			hosts("telemetry_record_turn", { turn: { workspaceId: "theirs" } }),
		).toEqual(["box"]);
		// A spawn without a Workspace goes by its folder.
		expect(hosts("pty_spawn", { cwd: "/home/dev/app/src" })).toEqual(["box"]);
		// Unknown things, and the Window's own settings, stay home.
		expect(hosts("fs_read_file", { path: "/etc/hosts" })).toEqual([null]);
		// Prompt actions are always this computer's (ADR-0064).
		expect(hosts("prompt_actions_list", {})).toEqual(["local"]);
	});

	it("splits a list across backends and joins the answers", () => {
		joinOne();
		const calls = routeCall("status_apply", {
			ops: [
				{ op: "touch", ptyId: "y-mine" },
				{ op: "touch", ptyId: "y-theirs" },
			],
		});
		expect(calls).toEqual([
			{ host: null, args: { ops: [{ op: "touch", ptyId: "y-mine" }] } },
			{ host: "box", args: { ops: [{ op: "touch", ptyId: "y-theirs" }] } },
		]);
		expect(mergeAnswers([[1], [2]])).toEqual([1, 2]);
		// The own backend always gets its part, even an empty one (a log
		// cleanup keeps exactly the panes it is given).
		expect(
			routeCall("pty_cleanup_stale_logs", { paneIds: ["p-theirs"] }),
		).toEqual([
			{ host: null, args: { paneIds: [] } },
			{ host: "box", args: { paneIds: ["p-theirs"] } },
		]);
	});

	it("cancels a search where it started", () => {
		joinOne();
		expect(
			hosts("fs_search", {
				params: { rootPath: "/home/dev/app", searchId: "s1" },
			}),
		).toEqual(["box"]);
		expect(hosts("fs_search_cancel", { searchId: "s1" })).toEqual(["box"]);
		expect(hosts("fs_search_cancel", { searchId: "s1" })).toEqual([null]);
	});
});

describe("sentByOwnerOf (ADR-0065: a Host speaks only for its own)", () => {
	beforeEach(() => {
		resetRouting();
		setOwnHost(null);
		joinOne();
	});

	it("lets this computer speak for its own Workspaces, and a Host for its joined ones", () => {
		expect(sentByOwnerOf(undefined, "workspace", "mine")).toBe(true);
		expect(sentByOwnerOf("box", "workspace", "theirs")).toBe(true);
		expect(sentByOwnerOf("box", "tab", "t-theirs")).toBe(true);
	});

	it("never lets a Host speak for this computer's Workspaces, Tabs, panes or PTYs", () => {
		expect(sentByOwnerOf("box", "workspace", "mine")).toBe(false);
		expect(sentByOwnerOf("box", "tab", "t-mine")).toBe(false);
		expect(sentByOwnerOf("box", "pane", "p-mine", { unknownOk: true })).toBe(
			false,
		);
		expect(sentByOwnerOf("box", "pty", "y-mine", { unknownOk: true })).toBe(
			false,
		);
		// Nor another Host for this one's.
		expect(sentByOwnerOf("lab", "workspace", "theirs")).toBe(false);
	});

	it("lets a pane or PTY not known yet through only where asked", () => {
		expect(sentByOwnerOf("box", "pty", "new", { unknownOk: true })).toBe(true);
		expect(sentByOwnerOf("box", "workspace", "unknown")).toBe(false);
	});

	it("in a remote Window, its own Host is its own backend", () => {
		setOwnHost("box");
		expect(sentByOwnerOf("box", "workspace", "unknown")).toBe(true);
		expect(sentByOwnerOf(undefined, "workspace", "unknown")).toBe(false);
	});
});
