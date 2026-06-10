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
import * as fixtures from "./fixtures";
import { publish } from "./mockBus";
import { seedPaneActivity } from "./seed";
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
		case "tab_create":
			return fixtures.workspaces[0].tabs[0];
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

		// ── GitHub ──
		case "gh_status":
			return fixtures.ghStatus;
		case "gh_review_requests":
			return fixtures.reviewPrsForCwd(String(args.cwd ?? ""));
		case "gh_review_requests_all":
			return fixtures.allReviewPrs;
		case "gh_my_prs":
			return fixtures.myPrsForCwd(String(args.cwd ?? ""));
		case "gh_my_prs_all":
			return fixtures.allMyPrs;

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
		case "pty_write":
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
		case "agent_hooks_provision":
		case "agent_hooks_provision_startup":
			return undefined;
		case "ensure_agent_hooks":
			// Demo never touches the filesystem; pretend nothing needed provisioning.
			return false;
		case "agent_hook_status":
			return fixtures.agentHookStatuses ?? [];

		// ── Updater — inert in demo (never touches the network) ──
		case "updater_check":
			return null;
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
		case "list_dev_environments":
			return fixtures.devEnvironments;
		case "launch_dev_environment":
			return undefined;

		default:
			console.warn(`[demo] unmocked command: ${cmd}`);
			return undefined;
	}
}
