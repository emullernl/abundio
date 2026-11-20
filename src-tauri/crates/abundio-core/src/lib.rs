//! **abundio-core**: what an Abundio Host runs with no window — Workspaces
//! and layouts, PTYs and their screens, pane status, the hook server and
//! Agent control (docs/plans/remote-hosts.md phase 6). No Tauri: the desktop
//! app (`src-tauri`) and the headless `abundio-server` are built on it, and
//! reach the app around them through traits (`event_sink::EventSink`,
//! `hook_server::HookHost`, `control_local::Live`).

pub mod agent_hooks;
pub mod agent_names;
pub mod agent_registry;
pub mod agent_skills;
pub mod app_paths;
pub mod change_hub;
pub mod config;
pub mod control_local;
pub mod control_protocol;
pub mod db_open;
pub mod env_crypto;
pub mod env_vars;
pub mod env_vars_commands;
pub mod error;
pub mod event_sink;
pub mod events;
pub mod file_explorer;
pub mod file_watcher;
pub mod gh_commands;
pub mod git_commands;
pub mod git_core;
pub mod git_libgit2;
pub mod git_scheduler;
pub mod hook_apply;
pub mod hook_route;
pub mod hook_server;
pub mod host_api;
pub mod host_client;
pub mod host_protocol;
pub mod layout_ops;
pub mod layout_store;
pub mod migrations;
pub mod orchestrator;
pub mod owner_map;
pub mod pane_facts;
pub mod process_monitor;
pub mod profile_store;
pub mod prompt_actions;
pub mod pty_manager;
pub mod screen;
pub mod search;
pub mod shell_env;
pub mod shell_integration;
pub mod status_machine;
pub mod status_store;
pub mod title_status;
pub mod workspace_folders;
pub mod workspace_store;
pub mod worktree_commands;
pub mod worktree_watcher;
