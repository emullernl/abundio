import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
	isTaskCapable,
	parseTaskArgsForm,
	TASK_PROMPT_PLACEHOLDER,
} from "../../lib/agents";
import { type AgentHookStatus, agentHooks, fs as fsApi } from "../../lib/ipc";
import type { CodingAgent } from "../../lib/types";
import { useAgentRegistryStore } from "../../stores/agentRegistryStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { ChevronDown, ChevronRight, ExternalLink, Plus, X } from "../Icons";
import { SectionLabel, Toggle, ToggleRow } from "./primitives";

/* ─── Agent hook footprint (per-row, expandable) ─── */
type HookTone = "success" | "warning" | "error" | "muted";

const HOOK_TONE_COLOR: Record<HookTone, string> = {
	success: "var(--success, #4ade80)",
	warning: "var(--warning, #d99a2b)",
	error: "var(--error, #f87171)",
	muted: "var(--fg-secondary)",
};

/**
 * The per-agent hook badge. `supported` is false for custom agents
 * (no hook integration); `installed` reflects the `$PATH` scan; `state` is the
 * live on-disk registration for a supported, installed agent.
 */
function hookBadge(
	hooksEnabled: boolean,
	supported: boolean,
	installed: boolean,
	state: AgentHookStatus["state"] | undefined,
): { label: string; tone: HookTone } {
	if (!supported) return { label: "Hooks not supported", tone: "muted" };
	if (!hooksEnabled) return { label: "Hooks off", tone: "muted" };
	if (!installed) return { label: "Not installed", tone: "muted" };
	switch (state) {
		case "registered":
			return { label: "Hooks registered", tone: "success" };
		case "configError":
			return { label: "Config error", tone: "error" };
		default:
			return { label: "Hooks not registered", tone: "warning" };
	}
}

/** The *Task-capable* badge: this Agent can be started by **New task**. */
function TaskBadge() {
	return (
		<span
			className="flex-shrink-0 rounded"
			title="Can start with a task prompt and stay interactive — offered by New task"
			style={{
				fontSize: 9,
				fontWeight: 600,
				color: "var(--accent)",
				letterSpacing: "0.05em",
				textTransform: "uppercase",
				padding: "2px 5px",
				border: "1px solid color-mix(in srgb, var(--accent) 40%, transparent)",
			}}
		>
			Task-capable
		</span>
	);
}

/**
 * A custom Agent's task argument form (`-i {prompt}`). Commits on blur or
 * Enter; an invalid form stays in the field with its error and is not saved.
 * Built-in Agents never show this: their form is fixed in code.
 */
function TaskArgsField({
	agent,
	onChange,
}: {
	agent: CodingAgent;
	onChange: (taskArgs: string[] | undefined) => void;
}) {
	const saved = agent.taskArgs?.join(" ") ?? "";
	const [value, setValue] = useState(saved);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => setValue(saved), [saved]);

	const commit = () => {
		const parsed = parseTaskArgsForm(value);
		if ("error" in parsed) {
			setError(parsed.error);
			return;
		}
		setError(null);
		onChange(parsed.taskArgs);
	};

	return (
		<div style={{ padding: "0 10px 9px 52px" }}>
			<input
				type="text"
				value={value}
				placeholder={`Task arguments (optional), e.g. -i ${TASK_PROMPT_PLACEHOLDER}`}
				aria-label="Task arguments"
				onChange={(e) => {
					setValue(e.target.value);
					setError(null);
				}}
				onBlur={commit}
				onKeyDown={(e) => e.key === "Enter" && commit()}
				className="w-full bg-transparent outline-none rounded-md"
				style={{
					color: "var(--fg-primary)",
					fontSize: 11,
					fontFamily: "var(--font-mono)",
					padding: "4px 8px",
					border: `1px solid ${error ? "var(--error)" : "var(--border)"}`,
					backgroundColor: "var(--bg-secondary)",
				}}
			/>
			{error && (
				<div style={{ fontSize: 11, color: "var(--error)", marginTop: 4 }}>
					{error}
				</div>
			)}
		</div>
	);
}

function HookBadge({ label, tone }: { label: string; tone: HookTone }) {
	const color = HOOK_TONE_COLOR[tone];
	return (
		<span
			className="flex-shrink-0 rounded"
			style={{
				fontSize: 9,
				fontWeight: 600,
				color,
				letterSpacing: "0.05em",
				textTransform: "uppercase",
				padding: "2px 5px",
				border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
			}}
		>
			{label}
		</span>
	);
}

function FootprintRow({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
			<span
				style={{
					fontSize: 10,
					fontWeight: 600,
					color: "var(--fg-secondary)",
					textTransform: "uppercase",
					letterSpacing: "0.05em",
					width: 52,
					flexShrink: 0,
				}}
			>
				{label}
			</span>
			<div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
				{children}
			</div>
		</div>
	);
}

/** The expandable detail: which file Abundio touches, how, and which events. */
function HookFootprint({
	status,
	hooksEnabled,
}: {
	status: AgentHookStatus;
	hooksEnabled: boolean;
}) {
	// The file is only guaranteed to exist when registered, or when a merge
	// config errored (it exists but is unparseable). Otherwise don't offer Open.
	const fileExists =
		status.state === "registered" || status.state === "configError";
	return (
		<div
			style={{
				padding: "8px 12px 12px 40px",
				display: "flex",
				flexDirection: "column",
				gap: 8,
				borderTop:
					"1px solid color-mix(in srgb, var(--border) 60%, transparent)",
			}}
		>
			{!hooksEnabled && (
				<div
					style={{
						fontSize: 11,
						color: "var(--fg-secondary)",
						lineHeight: 1.4,
					}}
				>
					Status Hooks are off — these are the changes Abundio would make to
					this agent when enabled.
				</div>
			)}
			<FootprintRow label="File">
				<span
					style={{
						fontFamily: "var(--font-mono)",
						fontSize: 11,
						color: "var(--fg-primary)",
						wordBreak: "break-all",
					}}
				>
					{status.configPath}
				</span>
				{fileExists && (
					<button
						type="button"
						onClick={() => {
							fsApi.revealInFolder(status.configPath).catch(console.error);
						}}
						className="flex items-center gap-1 flex-shrink-0 rounded transition-colors"
						style={{
							fontSize: 10,
							color: "var(--fg-secondary)",
							padding: "2px 6px",
							cursor: "pointer",
						}}
						onMouseEnter={(e) => {
							(e.currentTarget as HTMLElement).style.color = "var(--accent)";
							(e.currentTarget as HTMLElement).style.backgroundColor =
								"color-mix(in srgb, var(--accent) 12%, transparent)";
						}}
						onMouseLeave={(e) => {
							(e.currentTarget as HTMLElement).style.color =
								"var(--fg-secondary)";
							(e.currentTarget as HTMLElement).style.backgroundColor =
								"transparent";
						}}
					>
						<ExternalLink size={11} />
						Reveal
					</button>
				)}
			</FootprintRow>
			<FootprintRow label="Method">
				<span style={{ fontSize: 11, color: "var(--fg-secondary)" }}>
					{status.ownership === "owned"
						? "Abundio-owned file — deleted when hooks are disabled"
						: "Merged into the agent's own config — only Abundio's entries are removed when disabled"}
				</span>
			</FootprintRow>
			<FootprintRow label="Events">
				{status.events.map((e) => (
					<span
						key={e}
						style={{
							fontSize: 10,
							fontFamily: "var(--font-mono)",
							color: "var(--fg-secondary)",
							padding: "1px 5px",
							borderRadius: 4,
							backgroundColor: "var(--bg-tertiary)",
						}}
					>
						{e}
					</span>
				))}
			</FootprintRow>
		</div>
	);
}

/* ─── Agent row ─── */
function AgentRow({
	agent,
	installed,
	hooksEnabled,
	hookStatus,
	onToggle,
	onRemove,
	onTaskArgsChange,
}: {
	agent: CodingAgent;
	installed: boolean;
	hooksEnabled: boolean;
	hookStatus?: AgentHookStatus;
	onToggle: () => void;
	onRemove?: () => void;
	/** Only for custom Agents; built-ins have a fixed form. */
	onTaskArgsChange?: (taskArgs: string[] | undefined) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const supported = hookStatus !== undefined;
	const badge = hookBadge(
		hooksEnabled,
		supported,
		installed,
		hookStatus?.state,
	);

	return (
		<div
			className="flex flex-col rounded-lg group transition-colors"
			style={{
				backgroundColor: agent.enabled
					? "transparent"
					: "color-mix(in srgb, var(--bg-tertiary) 40%, transparent)",
			}}
		>
			<div className="flex items-center gap-3" style={{ padding: "9px 10px" }}>
				<Toggle checked={agent.enabled} onChange={onToggle} />
				<div
					className="flex-1 min-w-0"
					style={{
						opacity: agent.enabled ? 1 : 0.5,
					}}
				>
					<div
						className="truncate"
						style={{
							fontSize: 13,
							color: "var(--fg-primary)",
							lineHeight: 1.3,
						}}
					>
						{agent.name}
					</div>
					<div
						className="truncate"
						style={{
							fontSize: 11,
							color: "var(--fg-secondary)",
							fontFamily: "var(--font-mono)",
							marginTop: 1,
						}}
					>
						{agent.command}
						{agent.args?.length ? ` ${agent.args.join(" ")}` : ""}
					</div>
				</div>
				{agent.builtin && (
					<span
						className="flex-shrink-0 rounded"
						style={{
							fontSize: 9,
							fontWeight: 600,
							color: "var(--fg-secondary)",
							letterSpacing: "0.05em",
							textTransform: "uppercase",
							padding: "2px 5px",
							border: "1px solid var(--border)",
							opacity: 0.6,
						}}
					>
						Built-in
					</span>
				)}
				{installed && (
					<span
						className="flex-shrink-0 rounded"
						style={{
							fontSize: 9,
							fontWeight: 600,
							color: "var(--success, #4ade80)",
							letterSpacing: "0.05em",
							textTransform: "uppercase",
							padding: "2px 5px",
							border:
								"1px solid color-mix(in srgb, var(--success, #4ade80) 40%, transparent)",
						}}
					>
						Detected
					</span>
				)}
				{isTaskCapable(agent) && <TaskBadge />}
				<HookBadge label={badge.label} tone={badge.tone} />
				{/* Single trailing slot so the badge columns and this control line
				    up across every row: chevron for supported agents, the remove
				    button for custom ones, an empty spacer otherwise. */}
				{supported ? (
					<button
						type="button"
						onClick={() => setExpanded((v) => !v)}
						aria-label={expanded ? "Hide hook details" : "Show hook details"}
						className="flex-shrink-0 flex items-center justify-center rounded-md"
						style={{ width: 22, height: 22, color: "var(--fg-secondary)" }}
					>
						{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
					</button>
				) : onRemove ? (
					<button
						type="button"
						onClick={onRemove}
						aria-label="Remove agent"
						className="flex-shrink-0 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
						style={{ width: 22, height: 22, color: "var(--fg-secondary)" }}
						onMouseEnter={(e) => {
							(e.currentTarget as HTMLElement).style.color = "var(--error)";
							(e.currentTarget as HTMLElement).style.backgroundColor =
								"color-mix(in srgb, var(--error) 10%, transparent)";
						}}
						onMouseLeave={(e) => {
							(e.currentTarget as HTMLElement).style.color =
								"var(--fg-secondary)";
							(e.currentTarget as HTMLElement).style.backgroundColor =
								"transparent";
						}}
					>
						<X size={13} />
					</button>
				) : (
					<span style={{ width: 22, flexShrink: 0 }} aria-hidden />
				)}
			</div>
			{onTaskArgsChange && (
				<TaskArgsField agent={agent} onChange={onTaskArgsChange} />
			)}
			{expanded && hookStatus && (
				<HookFootprint status={hookStatus} hooksEnabled={hooksEnabled} />
			)}
		</div>
	);
}

/* ─── Add agent form ─── */
function AddAgentForm({
	onAdd,
}: {
	onAdd: (name: string, command: string, taskArgs?: string[]) => void;
}) {
	const [name, setName] = useState("");
	const [command, setCommand] = useState("");
	const [taskForm, setTaskForm] = useState("");

	const parsedTask = parseTaskArgsForm(taskForm);
	const taskError = "error" in parsedTask ? parsedTask.error : null;
	const canSubmit =
		name.trim().length > 0 && command.trim().length > 0 && !taskError;

	const handleSubmit = () => {
		if (!canSubmit || "error" in parsedTask) return;
		onAdd(name.trim(), command.trim(), parsedTask.taskArgs);
		setName("");
		setCommand("");
		setTaskForm("");
	};

	return (
		<div
			className="rounded-lg"
			style={{
				padding: "12px",
				backgroundColor: "var(--bg-primary)",
				border: "1px solid var(--border)",
			}}
		>
			<div
				className="font-medium"
				style={{
					fontSize: 11,
					color: "var(--fg-secondary)",
					letterSpacing: "0.04em",
					marginBottom: 8,
				}}
			>
				Add Custom Agent
			</div>
			<div className="flex gap-2">
				<input
					type="text"
					placeholder="Name"
					value={name}
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
					className="flex-1 bg-transparent outline-none rounded-md"
					style={{
						color: "var(--fg-primary)",
						fontSize: 12,
						padding: "6px 8px",
						border: "1px solid var(--border)",
						backgroundColor: "var(--bg-secondary)",
						minWidth: 0,
					}}
				/>
				<input
					type="text"
					placeholder="Command"
					value={command}
					onChange={(e) => setCommand(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
					className="flex-1 bg-transparent outline-none rounded-md"
					style={{
						color: "var(--fg-primary)",
						fontSize: 12,
						padding: "6px 8px",
						border: "1px solid var(--border)",
						backgroundColor: "var(--bg-secondary)",
						fontFamily: "var(--font-mono)",
						minWidth: 0,
					}}
				/>
				<button
					type="button"
					onClick={handleSubmit}
					disabled={!canSubmit}
					className="flex items-center gap-1.5 rounded-md transition-colors flex-shrink-0"
					style={{
						padding: "6px 10px",
						fontSize: 12,
						fontWeight: 500,
						color: canSubmit ? "var(--bg-primary)" : "var(--fg-secondary)",
						backgroundColor: canSubmit ? "var(--accent)" : "var(--bg-tertiary)",
						opacity: canSubmit ? 1 : 0.5,
						cursor: canSubmit ? "pointer" : "default",
					}}
				>
					<Plus size={12} />
					Add
				</button>
			</div>
			<input
				type="text"
				placeholder={`Task arguments (optional), e.g. -i ${TASK_PROMPT_PLACEHOLDER}`}
				aria-label="Task arguments"
				value={taskForm}
				onChange={(e) => setTaskForm(e.target.value)}
				onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
				className="w-full bg-transparent outline-none rounded-md"
				style={{
					marginTop: 8,
					color: "var(--fg-primary)",
					fontSize: 12,
					padding: "6px 8px",
					border: `1px solid ${taskError && taskForm.trim() ? "var(--error)" : "var(--border)"}`,
					backgroundColor: "var(--bg-secondary)",
					fontFamily: "var(--font-mono)",
				}}
			/>
			<div
				style={{
					fontSize: 11,
					color: taskError ? "var(--error)" : "var(--fg-secondary)",
					marginTop: 4,
					lineHeight: 1.4,
				}}
			>
				{taskError ??
					`Fill this in if the agent can start with a prompt and stay interactive — it then appears in New task.`}
			</div>
		</div>
	);
}

/* ─── Match-to-installed action ─── */

/**
 * Re-runs **Agent seeding** on demand: a `$PATH` rescan, then the built-in
 * Agents' Watched toggles set from what it found. The same rule a first run
 * applies (`lib/agentSeeding.ts`), so the button can never drift from it.
 *
 * Deliberately **not** called "Detect": in this section that word belongs to
 * the green *Detected* badge, which means one thing — the command is on
 * `$PATH`. This button acts on the toggles instead. See ADR-0037 and the
 * *Installed* / *Watched* entries in CONTEXT.md.
 *
 * No confirm dialog — every effect is one toggle-flip away from undone.
 */
function MatchToInstalledButton({ onDone }: { onDone: () => void }) {
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<MatchOutcome | null>(null);
	const [hovered, setHovered] = useState(false);

	// The result line is a transient acknowledgement, not state: it says the
	// press landed, then gets out of the way. The rows themselves are the
	// lasting answer.
	useEffect(() => {
		if (!result) return;
		const t = setTimeout(() => setResult(null), 6000);
		return () => clearTimeout(t);
	}, [result]);

	const run = useCallback(async () => {
		setBusy(true);
		setResult(null);
		let outcome: MatchOutcome = "failed";
		try {
			const { agents, matchAgentsToInstalled } = useSettingsStore.getState();
			// Rescan first: the section's last scan may predate an install made
			// minutes ago, and matching against a stale set is the one way this
			// button could switch off an Agent that is actually there.
			await useAgentRegistryStore
				.getState()
				.reload(agents.map((a) => a.command));
			const installed = useAgentRegistryStore.getState().installedCommands;
			outcome = await matchAgentsToInstalled(installed);
		} catch {
			// Stays "failed" — deliberately not "empty-scan". That message names
			// the PATH as the culprit, and it is only allowed to say so when the
			// scan genuinely came back empty.
			outcome = "failed";
		} finally {
			setResult(outcome);
			setBusy(false);
		}
		// Outside the try: a throw from refreshing the hook footprint happens
		// *after* the toggles have already moved, and must not be reported as a
		// match that didn't happen while the rows below visibly changed.
		onDone();
	}, [onDone]);

	const message = result ? MATCH_MESSAGE[result] : null;

	return (
		<div className="flex items-center gap-2.5 min-w-0">
			{message && (
				<span
					className="truncate"
					style={{
						fontSize: 11,
						lineHeight: 1.3,
						color: HOOK_TONE_COLOR[message.tone],
						// Fades in rather than appearing: the button sits in a dense
						// row of badges, and a hard swap there reads as a glitch.
						animation: "abundio-fade-in 160ms ease-out",
					}}
				>
					{message.text}
				</span>
			)}
			<button
				type="button"
				onClick={run}
				disabled={busy}
				onMouseEnter={() => setHovered(true)}
				onMouseLeave={() => setHovered(false)}
				title="Switch each built-in agent on if its command is on your PATH, off if it isn't. Your own custom agents are left alone."
				className="flex-shrink-0 rounded"
				style={{
					fontSize: 10,
					fontWeight: 600,
					letterSpacing: "0.05em",
					textTransform: "uppercase",
					padding: "4px 8px",
					color: busy ? "var(--fg-secondary)" : "var(--fg-primary)",
					backgroundColor:
						hovered && !busy
							? "color-mix(in srgb, var(--fg-primary) 8%, transparent)"
							: "transparent",
					border: "1px solid var(--border)",
					cursor: busy ? "default" : "pointer",
					opacity: busy ? 0.5 : 1,
					transition: "background-color 120ms ease, opacity 120ms ease",
				}}
			>
				{busy ? "Matching\u2026" : "Match to installed"}
			</button>
		</div>
	);
}

/** `settingsStore.matchAgentsToInstalled`'s result, plus `"failed"` for a throw
 *  on the way there — which is not the same thing and must not borrow the
 *  empty-scan wording. */
type MatchOutcome = "changed" | "already-matching" | "empty-scan" | "failed";

const MATCH_MESSAGE: Record<MatchOutcome, { text: string; tone: HookTone }> = {
	changed: { text: "Toggles now match what's installed.", tone: "success" },
	"already-matching": { text: "Already matching.", tone: "muted" },
	// Never phrased as "no agents found". An empty scan means the login shell
	// didn't answer far more often than it means the machine has none, and
	// saying the wrong one sends the user looking in the wrong place. Which is
	// also why anything that isn't an empty scan gets the generic line below.
	"empty-scan": {
		text: "Couldn't read your shell's PATH \u2014 nothing changed.",
		tone: "warning",
	},
	failed: { text: "Couldn't match \u2014 nothing changed.", tone: "error" },
};

export function AgentsSection() {
	const agents = useSettingsStore((s) => s.agents);
	const addAgent = useSettingsStore((s) => s.addAgent);
	const removeAgent = useSettingsStore((s) => s.removeAgent);
	const toggleAgent = useSettingsStore((s) => s.toggleAgent);
	const updateAgent = useSettingsStore((s) => s.updateAgent);
	const installedCommands = useAgentRegistryStore((s) => s.installedCommands);
	const reloadRegistry = useAgentRegistryStore((s) => s.reload);
	const agentHooksEnabled = useSettingsStore((s) => s.agentHooksEnabled);
	const setAgentHooksEnabled = useSettingsStore((s) => s.setAgentHooksEnabled);

	// Live per-agent hook footprint, keyed by agentId. Re-fetched when the
	// section mounts, and again after a toggle re-provisions, so the Hooks
	// registered / not registered badge reflects the new on-disk state.
	const [hookStatuses, setHookStatuses] = useState<
		Map<string, AgentHookStatus>
	>(() => new Map());
	const refreshHookStatuses = useCallback(() => {
		agentHooks
			.status()
			.then((list) => setHookStatuses(new Map(list.map((s) => [s.agentId, s]))))
			.catch(() => setHookStatuses(new Map()));
	}, []);
	useEffect(() => {
		// Read agents non-reactively: a detection toggle mutates the agents array,
		// but the toggle callbacks already refresh after provisioning, so we don't
		// want this effect re-firing on every toggle (a redundant IPC that reads
		// pre-provision state and flickers the badge). Runs on section-open;
		// add/remove refresh via their own handlers.
		reloadRegistry(useSettingsStore.getState().agents.map((a) => a.command));
		refreshHookStatuses();
	}, [reloadRegistry, refreshHookStatuses]);

	return (
		<div className="flex flex-col gap-4 flex-1 min-h-0">
			<div className="flex-1 min-h-0 overflow-y-auto">
				<SectionLabel>Status Hooks</SectionLabel>
				<ToggleRow
					checked={agentHooksEnabled}
					onChange={(v) => {
						setAgentHooksEnabled(v).then(refreshHookStatuses);
					}}
					style={{ marginBottom: 18 }}
					label="Agent status hooks"
					// Deliberately does not enumerate the supported agents: that list
					// lives in Rust (`agent_hooks::SUPPORTED_AGENTS`) and had already
					// drifted — Kimi and Grok were missing. The per-agent rows below
					// are the authoritative, self-updating answer.
					description="Registers hooks in every supported agent so its status icon reflects real agent state — including a distinct icon when an agent is waiting for your input. Edits each agent's global config; expand a row below to see exactly which file and which events. When off, those entries are removed and agent status falls back to detecting terminal activity, which can't tell when an agent is waiting for your input."
				/>
				{/* The label and the action share a baseline: the button operates on
				    the toggles in the rows below, so it belongs to their heading and
				    not to the Add-agent form at the foot of the pane. */}
				<div className="flex items-baseline justify-between gap-3">
					<SectionLabel>Coding Agents</SectionLabel>
					<MatchToInstalledButton onDone={refreshHookStatuses} />
				</div>
				<p
					style={{
						fontSize: 12,
						color: "var(--fg-secondary)",
						marginBottom: 12,
						lineHeight: 1.5,
					}}
				>
					Choose which agents Abundio watches for. A watched agent is offered in
					the launch menus, recognised when you run it in a terminal, and given
					status hooks. <strong style={{ fontWeight: 600 }}>Detected</strong>{" "}
					means the command was found on your PATH — separate from whether you
					want it watched.{" "}
					<strong style={{ fontWeight: 600 }}>Task-capable</strong> means the
					agent can start with a prompt and stay interactive, so New task can
					offer it.
				</p>
				<div className="flex flex-col gap-0.5">
					{agents.map((agent) => (
						<AgentRow
							key={agent.id}
							agent={agent}
							installed={installedCommands.has(agent.command)}
							hooksEnabled={agentHooksEnabled}
							hookStatus={hookStatuses.get(agent.id)}
							onToggle={() => {
								toggleAgent(agent.id).then(refreshHookStatuses);
							}}
							onRemove={agent.builtin ? undefined : () => removeAgent(agent.id)}
							onTaskArgsChange={
								agent.builtin
									? undefined
									: (taskArgs) => updateAgent(agent.id, { taskArgs })
							}
						/>
					))}
				</div>
			</div>
			<div className="flex-shrink-0">
				<AddAgentForm
					onAdd={(name, command) => {
						addAgent(name, command);
						// A newly added agent isn't in the last $PATH scan yet —
						// rescan so its Detected badge reflects reality.
						reloadRegistry(
							useSettingsStore.getState().agents.map((a) => a.command),
						);
					}}
				/>
			</div>
		</div>
	);
}
