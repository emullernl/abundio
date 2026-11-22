import { Cloud } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { type HostEntry, hostsApi } from "../../lib/ipc";
import type { AvailableShell } from "../../lib/types";
import { useSettingsHostStore } from "../../stores/settingsHostStore";
import { primaryButtonClass } from "../PromptActions/fieldStyles";
import { Select } from "../PromptActions/Select";
import { ScrollbackControl } from "./NumberSteppers";
import { SectionLabel } from "./primitives";
import { ShellPicker } from "./ShellPicker";

/**
 * Which Host the per-Host sections edit (ADR-0064, phase 10d-3): this
 * computer, or one of the Hosts added in Settings ▸ Hosts.
 */
export function SettingsHostPicker() {
	const hostId = useSettingsHostStore((s) => s.hostId);
	const [hosts, setHosts] = useState<HostEntry[]>([]);
	useEffect(() => {
		void hostsApi
			.list()
			.then(setHosts)
			.catch(() => setHosts([]));
	}, []);
	if (hosts.length === 0) return null;
	return (
		<div className="flex items-center gap-2" style={{ fontSize: 12 }}>
			<span style={{ color: "var(--fg-secondary)" }}>Host settings for</span>
			<div style={{ width: 200 }}>
				<Select
					value={hostId ?? ""}
					options={[
						{ value: "", label: "This computer" },
						...hosts.map((h) => ({ value: h.id, label: h.name })),
					]}
					onChange={(v) => useSettingsHostStore.getState().pick(v || null)}
				/>
			</div>
		</div>
	);
}

/**
 * A per-Host section: this computer's (`local`), or the picked Host's
 * (`host`) once it is connected and its settings are read. A Host not
 * connected shows "Connect to edit", never a stale copy.
 */
export function PerHostSection({
	local,
	host,
}: {
	local: ReactNode;
	host: ReactNode;
}) {
	const hostId = useSettingsHostStore((s) => s.hostId);
	const hostName = useSettingsHostStore((s) => s.hostName);
	const link = useSettingsHostStore((s) => s.link);
	if (!hostId) return <>{local}</>;
	return (
		<div className="flex flex-col gap-3 flex-1 min-h-0">
			<div
				className="flex items-center gap-2 flex-shrink-0"
				style={{ fontSize: 12, color: "var(--fg-secondary)" }}
			>
				<Cloud size={12} />
				<span>
					Editing{" "}
					<strong style={{ color: "var(--fg-primary)" }}>{hostName}</strong>
					's settings: they apply to every profile on it.
				</span>
			</div>
			{link.state === "ready" ? (
				host
			) : (
				<div
					className="flex flex-col gap-3 rounded-lg"
					style={{
						padding: "14px 16px",
						border: "1px solid var(--border)",
						maxWidth: 520,
					}}
				>
					<span style={{ fontSize: 13, color: "var(--fg-primary)" }}>
						{link.state === "connecting"
							? `Connecting to ${hostName}…`
							: `Not connected to ${hostName}.`}
					</span>
					{link.state === "offline" && (
						<>
							<span
								className="truncate"
								title={link.reason}
								style={{ fontSize: 11, color: "var(--fg-secondary)" }}
							>
								{link.reason}
							</span>
							<div>
								<button
									type="button"
									className={`${primaryButtonClass} rounded-md`}
									style={{
										fontSize: 12,
										height: 28,
										padding: "0 12px",
										color: "white",
										backgroundColor: "var(--accent)",
									}}
									onClick={() =>
										void useSettingsHostStore.getState().connect(true)
									}
								>
									Connect to edit
								</button>
							</div>
						</>
					)}
				</div>
			)}
		</div>
	);
}

/** Terminal's per-Host part for a Host: its scrollback and default shell. */
export function HostTerminalSettings() {
	const settings = useSettingsHostStore((s) => s.settings);
	const { update, call } = useSettingsHostStore.getState();
	if (!settings) return null;
	return (
		<>
			<div className="flex-shrink-0">
				<SectionLabel>Scrollback Lines</SectionLabel>
				<ScrollbackControl
					value={settings.scrollback ?? 1000}
					onChange={(n) => void update((s) => ({ ...s, scrollback: n }))}
				/>
			</div>
			<div className="flex flex-col flex-shrink-0" style={{ height: 200 }}>
				<SectionLabel>Default Shell</SectionLabel>
				<ShellPicker
					value={settings.shellPath}
					onChange={(path) => void update((s) => ({ ...s, shellPath: path }))}
					listShells={() => call<AvailableShell[]>("list_available_shells")}
				/>
			</div>
		</>
	);
}
