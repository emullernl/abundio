/**
 * Which backend a host command goes to (docs/plans/remote-hosts.md phase
 * 10). A Window shows its own Profile's Workspaces, on its own backend (this
 * computer, or the Host of a remote Window), and those of each **Joined
 * profile**, on that profile's Host. A call about a joined Workspace, or a
 * Tab, pane, PTY or file of one, goes to its Host; everything else goes
 * where it always did. With nothing joined, nothing changes.
 *
 * The Workspace store tells this module which Workspaces are joined and how
 * to find the Workspace of a Tab, pane, PTY or path (`setRoutingLookups`);
 * this module never imports a store, as `ipc.ts` imports it.
 *
 * Rust routes two things itself: a reply to an Agent control request goes
 * back to the Host that asked, and the settings every backend needs
 * (`TO_EVERY_BACKEND` in `host_commands.rs`) go to each joined Host too.
 */

/** Where the Workspace of a Tab, pane, PTY or path is. */
export interface RoutingLookups {
	workspaceOfTab: (tabId: string) => string | undefined;
	workspaceOfPane: (paneId: string) => string | undefined;
	workspaceOfPty: (ptyId: string) => string | undefined;
	/** The Workspace whose folder holds `path` (the deepest one). */
	workspaceOfPath: (path: string) => string | undefined;
}

let lookups: RoutingLookups | null = null;
/** Joined Workspace → its Host's id. */
const joinedWorkspaces = new Map<string, string>();
/** A search started on a Host → that Host, for its cancel. */
const searches = new Map<string, string>();

export function setRoutingLookups(l: RoutingLookups): void {
	lookups = l;
}

/** A Workspace of a Joined profile is on `hostId`; `null`: not joined. */
export function setJoinedWorkspace(
	workspaceId: string,
	hostId: string | null,
): void {
	if (hostId) joinedWorkspaces.set(workspaceId, hostId);
	else joinedWorkspaces.delete(workspaceId);
}

/** The Host a joined Workspace is on, if it is one. */
export function joinedHostOfWorkspace(workspaceId: string): string | null {
	return joinedWorkspaces.get(workspaceId) ?? null;
}

type By = "workspace" | "tab" | "pane" | "pty" | "path" | "profile";

/** How one command is routed. `arg` may be a dotted path into the
 *  arguments (`params.rootPath`); `split` names a list argument whose items
 *  may belong to different backends. */
type Route =
	| { by: "own" }
	/** Always this computer, whatever the Window's own backend: Prompt
	 *  actions (ADR-0064). */
	| { by: "local" }
	| { by: By; arg: string; or?: { by: By; arg: string } }
	| { split: string; item: (x: unknown) => [By, string] | null };

const own: Route = { by: "own" };
const local: Route = { by: "local" };
const w = (arg = "workspaceId"): Route => ({ by: "workspace", arg });
const path = (arg = "cwd"): Route => ({ by: "path", arg });
const pty = (arg = "ptyId"): Route => ({ by: "pty", arg });
const pane = (arg = "paneId"): Route => ({ by: "pane", arg });
const profile = (arg = "profileId"): Route => ({ by: "profile", arg });
const field =
	(by: By, key: string) =>
	(x: unknown): [By, string] | null => {
		const v =
			typeof x === "string" ? x : (x as Record<string, unknown> | null)?.[key];
		return typeof v === "string" ? [by, v] : null;
	};

/** Every host command and how it is routed (`hostRouting.test.ts` holds it
 *  to `HOST_API_COMMANDS`). */
export const HOST_ROUTES: Record<string, Route> = {
	// Terminals
	pty_spawn: {
		by: "workspace",
		arg: "workspaceId",
		or: { by: "path", arg: "cwd" },
	},
	pty_write: pty(),
	pty_resize: pty(),
	pty_kill: pty(),
	pty_alive: { split: "ptyIds", item: field("pty", "") },
	pty_redraw: pty(),
	pty_read_screen: pty(),
	pty_set_scrollback: own,
	pty_read_log: pane("logId"),
	pty_delete_log: pane("logId"),
	pty_cleanup_stale_logs: { split: "paneIds", item: field("pane", "") },
	pty_write_snapshot: pane(),
	pty_read_snapshot: pane(),
	default_shell: own,
	list_available_shells: own,
	status_apply: { split: "ops", item: field("pty", "ptyId") },
	status_byte_threshold_set: own,
	agent_commands_set: own,
	// The pane whose banner was answered: its Host made the offer.
	watch_offer_close: pane(),
	pane_facts_report: { split: "reports", item: field("pane", "paneId") },
	// Layouts and Tabs
	layout_apply: { by: "tab", arg: "tabId" },
	tab_list: w(),
	tab_create: w(),
	tab_delete: { by: "tab", arg: "id" },
	tab_update: { by: "tab", arg: "id" },
	// Workspaces
	workspace_list: profile(),
	workspace_create: profile(),
	workspace_update: w("id"),
	workspace_delete: w("id"),
	workspace_folder_check: profile(),
	workspace_missing_folders: profile(),
	workspace_reorder: { by: "workspace", arg: "ids.0" },
	workspace_restore_set: profile(),
	workspace_set_restore_active: profile(),
	workspace_set_restore_opened: w("id"),
	// Files and search
	fs_list_dir: path("path"),
	fs_home_dir: own,
	fs_list_files: path("rootPath"),
	fs_index_workspace_files: path("rootPath"),
	fs_read_file: path("path"),
	fs_write_file: path("path"),
	fs_file_exists: path("path"),
	fs_create_file: path("path"),
	fs_create_folder: path("path"),
	fs_rename: path("from"),
	fs_delete: path("path"),
	fs_search: path("params.rootPath"),
	fs_search_cancel: own, // see `searches`
	fs_watch_start: path("rootPath"),
	fs_watch_stop: path("rootPath"),
	// Git, GitHub and worktrees
	git_changed_files: path(),
	git_repo_slug: path(),
	git_snapshot_worktree: path(),
	git_diff_trees: path(),
	git_fetch_bundle: path(),
	git_fetch_upstream: path(),
	git_pull_ff: path(),
	git_file_diff: path(),
	git_commit_files: path(),
	git_commit_file_diff: path(),
	git_conflict_file: path(),
	git_stage_path: path(),
	git_branch_info: path(),
	git_status_fingerprint: path(),
	git_list_branches: path(),
	git_workspaces_summary: {
		split: "requests",
		item: field("workspace", "workspaceId"),
	},
	git_scheduler_start: w(),
	git_scheduler_stop: w(),
	list_repo_worktrees: path(),
	worktree_add: path("primaryCwd"),
	worktree_remove: path("primaryCwd"),
	worktree_dirty: path(),
	worktree_watch_set: { split: "commonDirs", item: field("path", "") },
	// Environment variables
	env_bundle_clear_injected: w(),
	env_bundle_create: w(),
	env_bundle_delete: w(),
	env_bundle_rename: w(),
	env_bundle_set_injected: w(),
	env_export_to_path: w(),
	env_injected_summary: w(),
	env_list: w(),
	env_retry_key: own,
	env_vars_delete: w(),
	env_vars_reorder: w(),
	env_vars_reveal: w(),
	env_vars_upsert: w(),
	env_vars_upsert_many: w(),
	// Agents and Agent control
	// Host settings (ADR-0064): the Window's own Host's; a joined Host's
	// are read and written on it explicitly (`joinedApi.callOn`).
	host_settings_get: own,
	host_settings_set: own,
	agent_control_enabled: own,
	agent_control_pane_for_number: w(),
	agent_control_pane_numbers: w(),
	agent_control_set_enabled: own,
	agent_handle_check: w(),
	agent_handle_default: w(),
	agent_hook_status: own,
	agent_hooks_provision: own,
	agent_hooks_provision_startup: own,
	agent_skill_provision: own,
	agent_skill_provision_startup: own,
	agent_skill_status: own,
	agents_claim_seeding: own,
	agents_commit_seeding: own,
	agents_path_is_resolved: own,
	ensure_agent_hooks: own,
	list_installed_agent_commands: own,
	agent_control_reply: own, // Rust sends it back to the Host that asked
	agent_control_pane_closed: pane(),
	// Notes, Prompt actions, statistics
	note_get: w(),
	note_set: w(),
	prompt_action_create: local,
	prompt_action_delete: local,
	prompt_action_update: local,
	prompt_actions_list: local,
	prompt_actions_reorder: local,
	prompt_actions_seed_orchestrator: local,
	telemetry_buckets: profile(),
	telemetry_list_turns: profile(),
	telemetry_record_turn: w("turn.workspaceId"),
	telemetry_totals: profile(),
	// Profiles and the Orchestrator
	server_profile_list: own,
	server_profile_create: own,
	server_profile_rename: own,
	server_profile_delete: own,
	client_profile_set: own,
	orchestrator_agent_get: profile(),
	orchestrator_agent_set: profile(),
	orchestrator_ensure: profile(),
	orchestrator_folder_get: profile(),
	orchestrator_folder_set: profile(),
	orchestrator_tab_add: profile(),
	orchestrator_tab_remove: profile(),
	orchestrator_tab_select: profile(),
	orchestrator_tab_set_view: profile(),
	orchestrator_tab_set_pdf_position: profile(),
	orchestrator_tabs_list: profile(),
};

function at(args: Record<string, unknown>, dotted: string): unknown {
	let v: unknown = args;
	for (const k of dotted.split(".")) {
		if (v === null || typeof v !== "object") return undefined;
		v = (v as Record<string, unknown>)[k];
	}
	return v;
}

/** The Window's own backend: `null` for this computer, a Host's id for a
 *  remote Window (the profile store sets it). */
let ownHost: string | null = null;
export function setOwnHost(hostId: string | null): void {
	ownHost = hostId;
}

/**
 * Whether an event that names `id` came from the backend that owns it
 * (ADR-0065): a Host speaks only for its own Workspaces, never this
 * computer's. `fromHost` is what the desktop stamped on a Host's event;
 * none means this computer's own backend.
 */
export function sentByOwnerOf(
	fromHost: unknown,
	by: "workspace" | "tab" | "pane" | "pty",
	id: string | null | undefined,
	opts: { unknownOk?: boolean } = {},
): boolean {
	const from = typeof fromHost === "string" ? fromHost : null;
	if (!id) return from === ownHost;
	const ws =
		by === "workspace"
			? id
			: by === "tab"
				? lookups?.workspaceOfTab(id)
				: by === "pane"
					? lookups?.workspaceOfPane(id)
					: lookups?.workspaceOfPty(id);
	// Not known here yet (a pane or PTY just started on its backend): no
	// Workspace to speak for, so nothing of this computer's is reached.
	if (!ws) return opts.unknownOk === true || from === ownHost;
	return from === (joinedWorkspaces.get(ws) ?? ownHost);
}

/** `sentByOwnerOf` for an event naming a folder (a file watch's root, a
 *  repository's git folder): its owner is the Workspace holding the path,
 *  and a path no Workspace holds is the Window's own backend's. */
export function sentByOwnerOfPath(
	fromHost: unknown,
	path: string | null | undefined,
): boolean {
	const from = typeof fromHost === "string" ? fromHost : null;
	const ws = path ? lookups?.workspaceOfPath(path) : undefined;
	return from === ((ws ? joinedWorkspaces.get(ws) : null) ?? ownHost);
}

/** The Host of one thing, or `null` for the Window's own backend. */
function hostOf(by: By, id: string): string | null {
	// A Profile id names a Profile only within one backend (every database
	// seeds the same Default id), so it always means the Window's own; calls
	// about a Joined profile name its Host (`joinedApi.callOn`).
	if (by === "profile") return null;
	let ws: string | undefined;
	if (by === "workspace") ws = id;
	else if (by === "tab") ws = lookups?.workspaceOfTab(id);
	else if (by === "pane") ws = lookups?.workspaceOfPane(id);
	else if (by === "pty") ws = lookups?.workspaceOfPty(id);
	else ws = lookups?.workspaceOfPath(id);
	return ws ? (joinedWorkspaces.get(ws) ?? null) : null;
}

/** One call to make: `host` is a Host's id, or `null` for the Window's own
 *  backend. */
export interface RoutedCall {
	host: string | null;
	args: Record<string, unknown>;
}

/** The call(s) to make for one host command. Several only for a list
 *  argument whose items are on different backends; the Window's own
 *  backend always gets its part, even when empty, as before. */
export function routeCall(
	command: string,
	args: Record<string, unknown>,
): RoutedCall[] {
	const fixed = HOST_ROUTES[command];
	if (fixed && "by" in fixed && fixed.by === "local") {
		return [{ host: "local", args }];
	}
	if (joinedWorkspaces.size === 0) {
		return [{ host: null, args }];
	}
	if (command === "fs_search_cancel") {
		const id = args.searchId;
		const host = typeof id === "string" ? (searches.get(id) ?? null) : null;
		if (typeof id === "string") searches.delete(id);
		return [{ host, args }];
	}
	const route = HOST_ROUTES[command] ?? own;
	if ("split" in route) {
		const list = at(args, route.split);
		if (!Array.isArray(list)) return [{ host: null, args }];
		const groups = new Map<string | null, unknown[]>([[null, []]]);
		for (const item of list) {
			const key = route.item(item);
			const host = key ? hostOf(key[0], key[1]) : null;
			const g = groups.get(host) ?? [];
			g.push(item);
			groups.set(host, g);
		}
		return [...groups].map(([host, items]) => ({
			host,
			args: { ...args, [route.split]: items },
		}));
	}
	if (route.by === "own" || route.by === "local") return [{ host: null, args }];
	let value = at(args, route.arg);
	let by: By = route.by;
	if (typeof value !== "string" && route.or) {
		by = route.or.by;
		value = at(args, route.or.arg);
	}
	const host = typeof value === "string" ? hostOf(by, value) : null;
	if (command === "fs_search" && host) {
		const id = at(args, "params.searchId");
		if (typeof id === "string") searches.set(id, host);
	}
	return [{ host, args }];
}

/** The answers of a split call, as one: lists joined, else the Window's
 *  own backend's answer. */
export function mergeAnswers(answers: unknown[]): unknown {
	if (answers.length === 1) return answers[0];
	if (answers.every(Array.isArray)) return (answers as unknown[][]).flat();
	return answers[0];
}

/** For tests: forget everything joined. */
export function resetRouting(): void {
	joinedWorkspaces.clear();
	searches.clear();
	lookups = null;
}
