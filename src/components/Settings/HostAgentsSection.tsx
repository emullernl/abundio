import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentHookStatus } from "../../lib/ipc";
import type { CodingAgent } from "../../lib/types";
import { agentsFromHostSettings } from "../../stores/hostAgentsStore";
import { useSettingsHostStore } from "../../stores/settingsHostStore";
import { secondaryButtonClass } from "../PromptActions/fieldStyles";
import { AddAgentForm, AgentRow } from "./AgentsSection";
import { CopyAgentsDialog } from "./CopyAgentsDialog";
import { SectionLabel, ToggleRow } from "./primitives";

/**
 * Settings ▸ Agents for a Host (ADR-0064, phase 10d-3): its Agent list, its
 * hooks, the Abundio skill and Agent control, all its own, read from it and
 * written to it. What is installed and which hooks are registered are that
 * Host's too. The app icon badge and session resume are this computer's, so
 * they stay under This computer.
 */
export function HostAgentsSection() {
	const settings = useSettingsHostStore((s) => s.settings);
	const hostName = useSettingsHostStore((s) => s.hostName);
	const { update, call } = useSettingsHostStore.getState();
	const agents = useMemo(
		() => (settings ? agentsFromHostSettings(settings) : []),
		[settings],
	);
	const [installed, setInstalled] = useState<Set<string>>(new Set());
	const [hookStatuses, setHookStatuses] = useState<
		Map<string, AgentHookStatus>
	>(new Map());
	const [controlEnabled, setControlEnabled] = useState<boolean | null>(null);
	const [copying, setCopying] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const commands = agents.map((a) => a.command).join("\n");
	const refresh = useCallback(() => {
		void call<string[]>("list_installed_agent_commands", {
			commands: commands.split("\n").filter(Boolean),
		})
			.then((list) => setInstalled(new Set(list)))
			.catch(() => setInstalled(new Set()));
		void call<AgentHookStatus[]>("agent_hook_status")
			.then((list) => setHookStatuses(new Map(list.map((s) => [s.agentId, s]))))
			.catch(() => setHookStatuses(new Map()));
	}, [call, commands]);
	useEffect(() => {
		refresh();
		void call<boolean>("agent_control_enabled")
			.then(setControlEnabled)
			.catch(() => setControlEnabled(true));
	}, [refresh, call]);

	if (!settings) {
		return (
			<p style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
				Reading {hostName}'s settings…
			</p>
		);
	}

	/** Write, then write the Agents' hooks and skill there to match. */
	const change = async (next: Parameters<typeof update>[0]) => {
		setError(null);
		try {
			await update(next);
			const s = useSettingsHostStore.getState().settings;
			if (!s) return;
			const on = Object.entries(s.agentSwitches)
				.filter(([, v]) => v)
				.map(([id]) => id);
			await call("agent_hooks_provision", {
				enabled: s.agentHooksEnabled,
				enabledAgents: on,
			}).catch(() => {});
			await call("agent_skill_provision", {
				enabled: s.agentSkillEnabled,
				enabledAgents: on,
			}).catch(() => {});
			refresh();
		} catch (e) {
			setError(String(e));
		}
	};

	const setSwitch = (agent: CodingAgent) =>
		change((s) =>
			agent.builtin
				? {
						...s,
						agentSwitches: { ...s.agentSwitches, [agent.id]: !agent.enabled },
					}
				: {
						...s,
						customAgents: s.customAgents.map((a) =>
							a.id === agent.id ? { ...a, enabled: !a.enabled } : a,
						),
					},
		);

	return (
		<div className="flex flex-col gap-4 flex-1 min-h-0">
			<div className="flex-1 min-h-0 overflow-y-auto">
				{error && (
					<div
						style={{ fontSize: 12, color: "var(--error)", marginBottom: 10 }}
					>
						{error}
					</div>
				)}
				<SectionLabel>Status Hooks</SectionLabel>
				<ToggleRow
					checked={settings.agentHooksEnabled}
					onChange={(v) => void change((s) => ({ ...s, agentHooksEnabled: v }))}
					style={{ marginBottom: 18 }}
					label="Agent status hooks"
					description={`Registers hooks in every supported agent on ${hostName}, so its status icon reflects real agent state. Edits each agent's global config there.`}
				/>
				<SectionLabel>Agent Control</SectionLabel>
				<ToggleRow
					checked={controlEnabled ?? true}
					onChange={(v) => {
						setControlEnabled(v);
						void call("agent_control_set_enabled", { enabled: v }).catch(() =>
							setControlEnabled(!v),
						);
					}}
					style={{ marginBottom: 18 }}
					label="Let agents control panes"
					description={`Agents in ${hostName}'s panes can use the abundio command on the panes and agents of their own profile there.`}
				/>
				<ToggleRow
					checked={settings.agentSkillEnabled}
					onChange={(v) => void change((s) => ({ ...s, agentSkillEnabled: v }))}
					style={{ marginBottom: 18 }}
					label="Install the Abundio skill for agents"
					description={`Teaches the watched agents on ${hostName} the abundio command.`}
				/>
				<div className="flex items-baseline justify-between gap-3">
					<SectionLabel>Coding Agents</SectionLabel>
					<button
						type="button"
						className={`${secondaryButtonClass} rounded-md`}
						style={{ fontSize: 12, height: 26, padding: "0 10px" }}
						onClick={() => setCopying(true)}
					>
						Copy from…
					</button>
				</div>
				<p
					style={{
						fontSize: 12,
						color: "var(--fg-secondary)",
						marginBottom: 12,
						lineHeight: 1.5,
					}}
				>
					The agents watched on {hostName}: offered in the launch menus of its
					workspaces, recognised when run in its terminals, and given status
					hooks there. <strong style={{ fontWeight: 600 }}>Detected</strong>{" "}
					means the command is on {hostName}'s PATH.
				</p>
				<div className="flex flex-col gap-0.5">
					{agents.map((agent) => (
						<AgentRow
							key={agent.id}
							agent={agent}
							installed={installed.has(agent.command)}
							hooksEnabled={settings.agentHooksEnabled}
							hookStatus={hookStatuses.get(agent.id)}
							onToggle={() => void setSwitch(agent)}
							onRemove={
								agent.builtin
									? undefined
									: () =>
											void change((s) => ({
												...s,
												customAgents: s.customAgents.filter(
													(a) => a.id !== agent.id,
												),
											}))
							}
							onTaskArgsChange={
								agent.builtin
									? undefined
									: (taskArgs) =>
											void change((s) => ({
												...s,
												customAgents: s.customAgents.map((a) =>
													a.id === agent.id ? { ...a, taskArgs } : a,
												),
											}))
							}
						/>
					))}
				</div>
			</div>
			<div className="flex-shrink-0">
				<AddAgentForm
					onAdd={(name, command, taskArgs) =>
						void change((s) => ({
							...s,
							customAgents: [
								...s.customAgents,
								{
									id: `custom-${crypto.randomUUID()}`,
									name,
									command,
									taskArgs,
									builtin: false,
									enabled: true,
								},
							],
						}))
					}
				/>
			</div>
			{copying && (
				<CopyAgentsDialog
					target={useSettingsHostStore.getState().hostId}
					have={agents}
					onCopy={(picked) =>
						change((s) => ({
							...s,
							customAgents: [...s.customAgents, ...picked],
						}))
					}
					onClose={() => setCopying(false)}
				/>
			)}
		</div>
	);
}
