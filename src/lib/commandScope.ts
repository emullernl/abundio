/**
 * Where each backend command runs (ADR-0062, docs/plans/remote-hosts.md
 * phase 1).
 *
 * - **host**: on the Host of the Workspace or Profile it is about — this
 *   computer for a local Profile, its Abundio server for a Remote profile.
 *   PTYs, files, git, Agents, layouts, settings that belong to a Host.
 * - **desktop**: always on the computer the app runs on, whatever the Host:
 *   windows and their placement, the app badge, the updater, the clipboard,
 *   launching desktop apps, the Window↔Profile binding.
 *
 * Today every command still goes to local Rust; the label is what a later
 * phase routes by. `commandScope.test.ts` fails when a command in `ipc.ts` or
 * Rust's handler list has no label, so a new command must choose.
 */
export type CommandScope = "host" | "desktop";

const DESKTOP = [
	// Windows, placement and the Window↔Profile binding.
	"create_untitled_profile_in_new_window",
	"focus_window",
	"get_active_profile_for_window",
	"get_profile_ownership_map",
	"open_settings_window",
	"open_window_with_profile",
	"set_active_profile_id",
	"set_settings_accelerator",
	// File windows: the window bookkeeping. Their file content is read and
	// written with `fs_*`, which are host commands.
	"file_window_focus",
	"file_window_forget",
	"file_window_info",
	"file_window_open",
	"file_window_set_dirty",
	"file_window_set_view",
	"file_windows_close",
	"file_windows_dirty",
	"file_windows_list",
	"file_windows_raise",
	"file_windows_restore",
	"file_windows_save",
	// Reported up for the app badge and the quit dialog.
	"report_attention_count",
	"report_busy_counts",
	"report_unsaved_files",
	// Desktop apps, fonts, clipboard, updater.
	"fs_reveal_in_folder",
	"launch_dev_environment",
	"list_dev_environments",
	"list_system_fonts",
	"plugin:app|version",
	// The Window's PTY output channel. For a remote Workspace the desktop
	// forwards the Host's stream into it.
	"pty_output_subscribe",
	// Reads the desktop clipboard; for a remote Workspace the saved file must
	// then be sent to the Host (phase 7).
	"prompt_attachment_from_clipboard",
	"set_clipboard_image_from_path",
	// The PR checker: the user's own GitHub review requests and PRs, whatever
	// the Host, polled while a desktop window has focus (phase 7b-4). Issues
	// for a New task (`gh_list_issues`) are the Workspace's repo: host.
	"pr_mark_read",
	"pr_poller_refresh",
	"pr_poller_set_config",
	"pr_poller_snapshot",
	// Which Host a Window is on, and the connection to it (phase 7c).
	"host_connect",
	"host_bind",
	// Hosts the user added and the Windows on them (phase 7d).
	"hosts_list",
	"hosts_add",
	"hosts_remove",
	"host_connect_saved",
	"host_request",
	"open_remote_profile_window",
	"remote_profile_for_window",
	"ssh_prompt_answer",
	// Setting up a Host from Settings ▸ Hosts (phase 8).
	"host_check",
	"host_install",
	"host_start",
	"host_uninstall",
	"updater_check",
	"updater_download",
	"updater_install_now",
	"updater_mark_version_seen",
	"updater_release_notes",
	"updater_set_auto_check",
	"updater_status",
] as const;

const HOST = [
	"agent_control_enabled",
	"agent_control_pane_closed",
	"agent_control_pane_for_number",
	"agent_control_pane_numbers",
	"agent_control_reply",
	"agent_control_set_enabled",
	"agent_handle_check",
	"agent_handle_default",
	"agent_hook_status",
	"agent_hooks_provision",
	"agent_hooks_provision_startup",
	"agent_skill_provision",
	"agent_skill_provision_startup",
	"agent_skill_status",
	"agents_claim_seeding",
	"agents_commit_seeding",
	"agents_path_is_resolved",
	"default_shell",
	"ensure_agent_hooks",
	"env_bundle_clear_injected",
	"env_bundle_create",
	"env_bundle_delete",
	"env_bundle_rename",
	"env_bundle_set_injected",
	"env_export_to_path",
	"env_injected_summary",
	"env_list",
	"env_retry_key",
	"env_vars_delete",
	"env_vars_reorder",
	"env_vars_reveal",
	"env_vars_upsert",
	"env_vars_upsert_many",
	"fs_create_file",
	"fs_create_folder",
	"fs_delete",
	"fs_file_exists",
	"fs_index_workspace_files",
	"fs_list_dir",
	"fs_list_files",
	"fs_read_file",
	"fs_rename",
	"fs_search",
	"fs_search_cancel",
	"fs_watch_start",
	"fs_watch_stop",
	"fs_write_file",
	"gh_list_issues",
	"git_branch_info",
	"git_changed_files",
	"git_commit_file_diff",
	"git_commit_files",
	"git_conflict_file",
	"git_diff_trees",
	"git_fetch_bundle",
	"git_file_diff",
	"git_list_branches",
	"git_repo_slug",
	"git_scheduler_start",
	"git_scheduler_stop",
	"git_snapshot_worktree",
	"git_stage_path",
	"git_status_fingerprint",
	"git_workspaces_summary",
	"layout_apply",
	"list_available_shells",
	"list_installed_agent_commands",
	"list_repo_worktrees",
	"note_get",
	"note_set",
	"orchestrator_agent_get",
	"orchestrator_agent_set",
	"orchestrator_ensure",
	"orchestrator_folder_get",
	"orchestrator_folder_set",
	"orchestrator_tab_add",
	"orchestrator_tab_remove",
	"orchestrator_tab_select",
	"orchestrator_tab_set_view",
	"orchestrator_tabs_list",
	"pane_facts_report",
	"profile_create",
	"profile_delete",
	"profile_list",
	"profile_reorder",
	"profile_update",
	"prompt_action_create",
	"prompt_action_delete",
	"prompt_action_update",
	"prompt_actions_list",
	"prompt_actions_reorder",
	"pty_cleanup_stale_logs",
	"pty_delete_log",
	"pty_kill",
	"pty_read_log",
	"pty_read_screen",
	"pty_read_snapshot",
	"pty_redraw",
	"pty_resize",
	"pty_set_scrollback",
	"pty_spawn",
	"pty_write",
	"pty_write_snapshot",
	"status_apply",
	// A Host's own Profiles, for its remote Windows (phase 7d).
	"server_profile_list",
	"server_profile_create",
	"client_profile_set",
	// The door to the host commands above for a local Profile (phase 7b).
	"host_call",
	"agent_commands_set",
	"status_byte_threshold_set",
	"tab_create",
	"tab_delete",
	"tab_list",
	"tab_update",
	"telemetry_buckets",
	"telemetry_list_turns",
	"telemetry_record_turn",
	"telemetry_totals",
	"workspace_create",
	"workspace_delete",
	"workspace_folder_check",
	"workspace_list",
	"workspace_missing_folders",
	"workspace_reorder",
	"workspace_restore_set",
	"workspace_set_restore_active",
	"workspace_set_restore_opened",
	"workspace_update",
	"worktree_add",
	"worktree_dirty",
	"worktree_remove",
	"worktree_watch_set",
] as const;

export const COMMAND_SCOPE: ReadonlyMap<string, CommandScope> = new Map<
	string,
	CommandScope
>([
	...DESKTOP.map((c) => [c, "desktop"] as const),
	...HOST.map((c) => [c, "host"] as const),
]);

/** Where `command` runs. Unknown commands are host: the safe default for a
 *  command that touches a Workspace. */
export function commandScope(command: string): CommandScope {
	return COMMAND_SCOPE.get(command) ?? "host";
}
