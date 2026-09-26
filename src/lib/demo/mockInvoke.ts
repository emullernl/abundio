/**
 * Demo-mode replacement for Tauri's `invoke`. Returns in-memory fixtures for
 * every read command, treats every mutating command as an inert no-op (so the
 * real DB / git / GitHub / filesystem / PTYs are never touched), and on
 * `pty_spawn` schedules the pane's canned transcript and seeds its activity
 * (status-dot) state.
 *
 * Keyed off the stable **paneId** (`pty_spawn`'s `logId` arg), because
 * `workspaceStore.loadWorkspaces` clears layout ptyIds on load.
 */
import type { PromptActionRow } from "../types";
import * as fixtures from "./fixtures";
import { publish } from "./mockBus";
import { seedPaneActivity } from "./seed";
import * as telemetry from "./telemetry";
import { DEMO_FALLBACK, encodeBase64, TRANSCRIPTS } from "./transcripts";

type Args = Record<string, unknown> | undefined;

const warned = new Set<string>();
/** Log a dev-facing warning at most once per key, so a contributor poking at a
 *  demo-disabled command isn't spammed (or left wondering why nothing happens). */
function warnOnce(key: string, message: string): void {
	if (warned.has(key)) return;
	warned.add(key);
	console.warn(message);
}

/**
 * Prompt actions for the demo, mutable for the session.
 *
 * Deliberately a small, plausible set rather than an empty list: a real install
 * seeds none (a stock "/review" would assume a slash command only some installs
 * have), but a demo whose headline feature renders nothing shows nothing.
 */
const demoPromptActions: PromptActionRow[] = [
	{
		id: "demo-action-review",
		name: "Review changes",
		body: "/review",
		scopeKind: "set",
		scopeAgentIds: ["claude"],
		paramsJson: "{}",
		showInBar: true,
		position: 0,
		createdAt: 0,
		updatedAt: 0,
	},
	{
		id: "demo-action-explain",
		name: "Explain",
		body: "Explain what {{symbol}} does and where it is used.",
		scopeKind: "all",
		scopeAgentIds: [],
		paramsJson: JSON.stringify({ symbol: { type: "text" } }),
		showInBar: true,
		position: 1,
		createdAt: 0,
		updatedAt: 0,
	},
	{
		id: "demo-action-test",
		name: "Write a test",
		body: "Write a unit test for {{target}}.\n\n{{thorough}}",
		scopeKind: "all",
		scopeAgentIds: [],
		paramsJson: JSON.stringify({
			target: { type: "text" },
			thorough: {
				type: "toggle",
				onText: "Cover the edge cases exhaustively.",
				offText: "Keep it to the happy path.",
			},
		}),
		showInBar: true,
		position: 2,
		createdAt: 0,
		updatedAt: 0,
	},
];

function seedPane(paneId: string, ptyId: string): void {
	publish(`pty-status-${ptyId}`, { type: "running" });

	// Panes the user creates at runtime (new tab, split, launch picker) aren't
	// in the fixtures — show a "demo mode" banner instead of a blank terminal
	// that reports `running` forever.
	const spec = fixtures.agentPanes[paneId];
	if (!spec) {
		publish(`pty-output-${ptyId}`, { data: encodeBase64(DEMO_FALLBACK) });
		return;
	}

	const transcript = TRANSCRIPTS[spec.transcript];
	if (transcript) {
		publish(`pty-output-${ptyId}`, { data: encodeBase64(transcript) });
	}

	seedPaneActivity(ptyId, paneId, spec);
}

export function mockInvoke<T>(cmd: string, args?: Args): Promise<T> {
	const result = dispatch(cmd, args ?? {});
	return Promise.resolve(result as T);
}

function dispatch(cmd: string, args: Record<string, unknown>): unknown {
	switch (cmd) {
		// ── Profiles ──
		case "profile_list":
			return fixtures.profiles;
		case "get_active_profile_for_window":
			return fixtures.ACTIVE_PROFILE_ID;
		case "get_profile_ownership_map":
			return {};
		case "profile_create":
			return fixtures.profiles[0];
		case "profile_update":
		case "profile_delete":
		case "profile_reorder":
		case "set_active_profile_id":
			return undefined;

		// ── Workspaces / tabs / notes ──
		case "workspace_list":
			return fixtures.workspaces;
		case "workspace_create":
			return fixtures.workspaces[0];
		case "workspace_update":
		case "workspace_delete":
		case "workspace_reorder":
			return undefined;
		case "tab_list": {
			const ws = fixtures.workspaces.find((w) => w.id === args.workspaceId);
			return ws?.tabs ?? [];
		}
		case "tab_create": {
			// A fresh Tab with one fresh terminal pane. Returning an existing Tab
			// here would duplicate its pane ids across two layouts.
			const id = crypto.randomUUID();
			return {
				id,
				workspaceId: String(args.workspaceId ?? ""),
				name: String(args.name ?? "Terminal"),
				layoutJson: JSON.stringify({
					type: "terminal",
					id: crypto.randomUUID(),
					ptyId: "",
				}),
				position: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
		}
		case "tab_update":
		case "tab_delete":
			return undefined;
		case "note_get":
			return "";
		case "note_set":
			return undefined;

		// ── Git ──
		case "git_fetch_bundle":
			return fixtures.gitBundleForCwd(String(args.cwd ?? ""));
		case "git_changed_files":
			return fixtures.gitBundleForCwd(String(args.cwd ?? "")).changedFiles;
		case "git_branch_info":
			return fixtures.gitBundleForCwd(String(args.cwd ?? "")).branchInfo;
		case "git_list_branches":
			return fixtures.branchesForCwd[String(args.cwd ?? "")] ?? ["main"];
		case "git_status_fingerprint":
			return fixtures.gitBundleForCwd(String(args.cwd ?? "")).statusFingerprint;
		case "git_file_diff": {
			const filePath = String(args.filePath ?? "");
			return (
				fixtures.fileDiffs[filePath] ?? {
					filePath,
					original: "",
					modified: fixtures.fileContents[filePath] ?? "",
				}
			);
		}
		case "git_commit_files":
			return fixtures.commitFilesByOid[String(args.oid ?? "")] ?? [];
		case "git_commit_file_diff": {
			const filePath = String(args.filePath ?? "");
			return (
				fixtures.fileDiffs[filePath] ?? {
					filePath,
					original: "",
					modified: fixtures.fileContents[filePath] ?? "",
				}
			);
		}
		case "git_conflict_file":
			return fixtures.conflictFile(
				String(args.cwd ?? ""),
				String(args.filePath ?? ""),
			);
		case "git_stage_path":
			warnOnce("git_stage_path", "[demo] staging is disabled");
			return undefined;
		case "git_workspaces_summary": {
			const requests =
				(args.requests as { workspaceId: string; cwd: string }[]) ?? [];
			return requests.map((r) =>
				fixtures.workspaceSummary(r.workspaceId, r.cwd),
			);
		}
		case "git_scheduler_start":
		case "git_scheduler_stop":
			return undefined;

		// ── Worktrees (demo treats every repo as a lone main worktree) ──
		case "list_repo_worktrees":
			return [];
		case "worktree_dirty":
			return false;
		case "worktree_add":
		case "worktree_remove":
		case "worktree_watch_set":
			return undefined;

		// ── GitHub (app-global PR poller, ADR-0019) ──
		case "pr_poller_snapshot":
			// One account-wide payload; the panel filters All-vs-Repo client-side
			// using the repo slug below.
			return {
				...fixtures.ghStatus,
				reviewRequested: fixtures.allReviewPrs,
				mine: fixtures.allMyPrs,
				error: null,
				unreadError: null,
			};
		case "gh_list_issues":
			return [
				{
					number: 214,
					title: "Split view loses scroll position on resize",
					url: "https://github.com/acme/app/issues/214",
					updatedAt: "2026-09-20T10:00:00Z",
					labels: ["bug"],
					assignedToMe: true,
				},
				{
					number: 209,
					title: "Add CSV export to the reports page",
					url: "https://github.com/acme/app/issues/209",
					updatedAt: "2026-09-18T10:00:00Z",
					labels: ["enhancement"],
					assignedToMe: false,
				},
			];
		case "pr_mark_read":
		case "pr_poller_refresh":
		case "pr_poller_set_config":
			return undefined;
		case "git_repo_slug":
			return fixtures.repoForCwd(String(args.cwd ?? ""));
		case "git_snapshot_worktree":
			return null;
		case "git_diff_trees":
			return { additions: 0, deletions: 0, files: 0 };

		// ── Filesystem (reads) ──
		case "fs_list_dir":
			return fixtures.listDir(String(args.path ?? ""));
		case "fs_list_files":
			return fixtures.fileEntries(String(args.rootPath ?? ""));
		case "fs_index_workspace_files":
			return fixtures.fileIndex(String(args.rootPath ?? ""));
		case "fs_read_file":
			return fixtures.readFile(String(args.path ?? ""));
		case "fs_file_exists":
			return true;
		case "fs_search":
			warnOnce("fs_search", "[demo] workspace search is disabled");
			return { files: [], totalMatches: 0, truncated: false };

		// ── Filesystem (mutations / side effects) — inert ──
		case "fs_write_file":
		case "fs_create_file":
		case "fs_create_folder":
		case "fs_rename":
		case "fs_delete":
		case "fs_reveal_in_folder":
		case "fs_watch_start":
		case "fs_watch_stop":
		case "fs_search_cancel":
			return undefined;

		// ── PTY ──
		case "pty_spawn": {
			const ptyId = String(args.ptyId ?? "");
			const paneId = String(args.logId ?? "");
			seedPane(paneId, ptyId);
			return ptyId;
		}
		case "pty_read_log":
		case "pty_read_snapshot":
			return null;
		// Echo what was written back onto the pane's output channel, so a Prompt
		// action fired in the demo visibly types into the fake agent instead of
		// doing nothing at all. Not a raw echo: the bracketed-paste wrappers
		// would render as stray text, and a bare `\r` would return the cursor to
		// column zero so the next output overwrote what was just "typed".
		//
		// This changes demo typing generally — today typing into a demo pane does
		// nothing — which is an improvement, but is broader than Prompt actions.
		case "pty_write": {
			const ptyId = String(args.ptyId ?? "");
			const raw = String(args.data ?? "");
			if (!ptyId || !raw) return undefined;
			const echo = raw
				// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes
				.replace(/\u001b\[20[01]~/g, "")
				.replace(/\r\n?/g, "\r\n");
			if (echo) publish(`pty-output-${ptyId}`, { data: encodeBase64(echo) });
			return undefined;
		}
		case "pty_redraw":
			return true;
		case "pty_resize":
		case "pty_kill":
		case "pty_write_snapshot":
		case "pty_delete_log":
		case "pty_cleanup_stale_logs":
			return undefined;

		// ── Agents / system ──
		case "list_installed_agent_commands": {
			const requested = (args.commands as string[]) ?? [];
			return requested.filter((c) => fixtures.installedAgentCommands.has(c));
		}
		// The demo's agent set is curated, so seeding must never run against it
		// — and the demo has no install to seed anyway. See ADR-0037.
		case "agents_claim_seeding":
			return false;
		case "agents_commit_seeding":
			return undefined;
		case "agent_hooks_provision":
		case "agent_hooks_provision_startup":
			return undefined;
		case "ensure_agent_hooks":
			// Demo never touches the filesystem; pretend nothing needed provisioning.
			return false;
		case "agent_hook_status":
			return fixtures.agentHookStatuses ?? [];

		// ── Agent Turn telemetry — synthesised demo dataset ──
		case "telemetry_buckets":
			return telemetry.telemetryBuckets(
				String(args.profileId ?? ""),
				Number(args.fromMs ?? 0),
				Number(args.toMs ?? 0),
				String(args.bucket ?? "day"),
				String(args.groupBy ?? "none"),
			);
		case "telemetry_totals":
			return telemetry.telemetryTotals(
				String(args.profileId ?? ""),
				Number(args.fromMs ?? 0),
				Number(args.toMs ?? 0),
			);
		case "telemetry_list_turns":
			return telemetry.telemetryListTurns(
				String(args.profileId ?? ""),
				Number(args.fromMs ?? 0),
				Number(args.toMs ?? 0),
			);
		case "telemetry_record_turn":
			return undefined; // inert — demo never persists

		// ── Updater — inert in demo (never touches the network) ──
		case "updater_check":
			return null;
		case "updater_status":
			return { state: "none", info: null };
		case "updater_release_notes":
			return { releases: [], hasMore: false };
		case "updater_mark_version_seen":
			return undefined;
		case "plugin:app|version":
			return fixtures.appVersion;
		case "updater_download":
		case "updater_install_now":
		case "updater_set_auto_check":
			return undefined;
		// ── Clipboard image (Smart image drop) — inert in demo ──
		case "set_clipboard_image_from_path":
			return undefined;

		case "list_system_fonts":
			return fixtures.systemFonts;
		case "list_available_shells":
			return fixtures.availableShells;
		case "default_shell":
			return "/bin/zsh";
		case "list_dev_environments":
			return fixtures.devEnvironments;
		case "launch_dev_environment":
			return undefined;

		// ── Prompt actions ──
		// Served from an in-memory list so the Action bar, the parameter dialog
		// and the Settings section all render. Writes are accepted and kept for
		// the session; nothing is persisted.
		case "prompt_actions_list":
			return demoPromptActions;
		case "prompt_action_create": {
			const input = (args.action ?? {}) as Record<string, unknown>;
			const row = {
				id: `demo-action-${demoPromptActions.length + 1}`,
				name: String(input.name ?? "Untitled"),
				body: String(input.body ?? ""),
				scopeKind: (input.scopeKind as "all" | "set") ?? "all",
				scopeAgentIds: (input.scopeAgentIds as string[]) ?? [],
				paramsJson: String(input.paramsJson ?? "{}"),
				showInBar: input.showInBar !== false,
				position: demoPromptActions.length,
				createdAt: 0,
				updatedAt: 0,
			};
			demoPromptActions.push(row);
			publish("prompt-actions-changed", undefined);
			return row;
		}
		case "prompt_action_update": {
			const id = String(args.id ?? "");
			const patch = (args.updates ?? {}) as Record<string, unknown>;
			const row = demoPromptActions.find((a) => a.id === id);
			if (!row) throw new Error(`Not found: prompt action ${id}`);
			Object.assign(row, patch);
			publish("prompt-actions-changed", undefined);
			return row;
		}
		case "prompt_action_delete": {
			const id = String(args.id ?? "");
			const at = demoPromptActions.findIndex((a) => a.id === id);
			if (at >= 0) demoPromptActions.splice(at, 1);
			publish("prompt-actions-changed", undefined);
			return undefined;
		}
		case "prompt_actions_reorder": {
			const ids = (args.ids as string[]) ?? [];
			for (const [i, id] of ids.entries()) {
				const row = demoPromptActions.find((a) => a.id === id);
				if (row) row.position = i;
			}
			demoPromptActions.sort((a, b) => a.position - b.position);
			publish("prompt-actions-changed", undefined);
			return undefined;
		}
		// An attachment cannot really be saved in `demo:web` — a browser File has
		// no filesystem path, and paths are the whole mechanism (ADR-0038). Hand
		// back a canned path so the dialog looks complete in a screenshot while
		// being honest that nothing was written.
		case "prompt_attachment_from_clipboard":
			return ["/Users/demo/Screenshots/login-error.png"];

		// ── Environment variables — inert in demo ──
		// Demo mode never touches the OS credential store, so every Workspace
		// reports one empty injected Bundle and no key error. Enough for the
		// settings dialog to render without throwing.
		case "env_list":
			return {
				bundles: [
					{
						id: "demo-bundle",
						workspaceId: String(args.workspaceId ?? ""),
						name: "default",
						injected: true,
						position: 0,
						varCount: 0,
						inherited: false,
					},
				],
				selectedBundle: "default",
				vars: [],
				keyError: null,
				bytesUsed: 0,
				bytesBudget: 65536,
			};
		case "env_injected_summary":
			// Matches the `env_list` mock above: the demo bundle IS injected, it
			// is just empty — so the status pill correctly stays hidden.
			return { bundle: "default", varCount: 0, inherited: false };
		case "env_bundle_clear_injected":
			return undefined;

		// Per-window bookkeeping the Rust side owns; nothing to report in the
		// demo, and it fires whenever the busy tally changes.
		case "report_busy_counts":
			return undefined;
		case "env_retry_key":
			return true;
		case "env_vars_reveal":
			return "";
		case "env_bundle_create":
		case "env_bundle_rename":
		case "env_bundle_set_injected":
		case "env_bundle_delete":
		case "env_vars_upsert":
		case "env_vars_upsert_many":
		case "env_vars_delete":
		case "env_vars_reorder":
			return undefined;

		default:
			console.warn(`[demo] unmocked command: ${cmd}`);
			return undefined;
	}
}
