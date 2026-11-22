import { useCallback, useEffect, useRef, useState } from "react";
import { panesEndedBy, restartMessage } from "../../lib/hostSetup";
import {
	type HostCheck,
	type HostEntry,
	hostsApi,
	listen,
	listenToThisWindow,
} from "../../lib/ipc";
import { useSettingsStore } from "../../stores/settingsStore";
import { ConfirmDialog } from "../ConfirmDialog";
import {
	paramTextInputStyle,
	primaryButtonClass,
	secondaryButtonClass,
} from "../PromptActions/fieldStyles";
import { HostChecklist } from "./HostChecklist";
import { SectionLabel } from "./primitives";

const REMOVING = "Removing the server…";

/** What a checklist button shows while it works. */
const WORKING_LABELS: Record<string, string> = {
	install: "Installing…",
	update: "Updating…",
	start: "Starting…",
	service: "Restarting…",
};

/**
 * Settings ▸ Hosts (docs/plans/remote-hosts.md phase 7d): the machines an
 * Abundio server runs on, reached with the user's own `ssh`. Adding one
 * only remembers how to reach it; File ▸ Open Remote Profile… connects.
 * Check, then Install / Start, sets a Host up (phase 8).
 */
export function HostsSection() {
	const [hosts, setHosts] = useState<HostEntry[]>([]);
	const [name, setName] = useState("");
	const [destination, setDestination] = useState("");
	const [server, setServer] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	/** Each Host's last check, or why it failed. */
	const [checks, setChecks] = useState<
		Record<string, HostCheck | { error: string } | "checking">
	>({});

	/** What setup is doing on each Host now ("Uploading the server…"). */
	const [working, setWorking] = useState<Record<string, string>>({});

	useEffect(() => {
		const off = listenToThisWindow<{ hostId: string; text: string }>(
			"host-setup-progress",
			(e) => setWorking((w) => ({ ...w, [e.payload.hostId]: e.payload.text })),
		);
		return () => {
			off.then((stop) => stop());
		};
	}, []);

	const agentCommands = () =>
		useSettingsStore
			.getState()
			.agents.filter((a) => a.enabled)
			.map((a) => a.command);

	/** A restart waiting for the user's yes: it would end running panes. */
	const [confirmRestart, setConfirmRestart] = useState<{
		id: string;
		last: HostCheck;
		action: string;
		message: string;
	} | null>(null);
	/** The Host whose Remove is asking how, and the uninstall waiting for
	 *  its yes. */
	const [removing, setRemoving] = useState<string | null>(null);
	const [confirmUninstall, setConfirmUninstall] = useState<HostEntry | null>(
		null,
	);

	const askAction = (host: HostEntry, last: HostCheck, action: string) => {
		const panes = panesEndedBy(action, last);
		if (panes > 0) {
			setConfirmRestart({
				id: host.id,
				last,
				action,
				message: restartMessage(action, host.name, panes),
			});
		} else {
			void runAction(host.id, last, action);
		}
	};

	const runAction = async (id: string, last: HostCheck, action: string) => {
		const label = WORKING_LABELS[action];
		if (!label) return;
		setWorking((w) => ({ ...w, [id]: label }));
		try {
			const result =
				action === "start" || action === "service"
					? await hostsApi.start(id, action === "service", agentCommands())
					: await hostsApi.install(
							id,
							last.probe.os,
							last.probe.arch,
							agentCommands(),
						);
			setChecks((c) => ({ ...c, [id]: result }));
		} catch (e) {
			setChecks((c) => ({ ...c, [id]: { error: String(e) } }));
		} finally {
			setWorking(({ [id]: _, ...rest }) => rest);
		}
	};

	const check = async (id: string) => {
		setChecks((c) => ({ ...c, [id]: "checking" }));
		const agents = agentCommands();
		try {
			const result = await hostsApi.check(id, agents);
			setChecks((c) => ({ ...c, [id]: result }));
		} catch (e) {
			setChecks((c) => ({ ...c, [id]: { error: String(e) } }));
		}
	};

	const reload = useCallback(() => {
		hostsApi
			.list()
			.then(setHosts)
			.catch(() => setHosts([]));
	}, []);

	// Opened to check one Host (a Window whose Host runs another server
	// version): check it, so its checklist offers Update.
	const checkRef = useRef(check);
	checkRef.current = check;
	useEffect(() => {
		const asked = new URLSearchParams(window.location.search).get("check");
		if (asked) void checkRef.current(asked);
		const off = listenToThisWindow<string>("settings-check-host", (e) => {
			void checkRef.current(e.payload);
		});
		return () => {
			void off.then((stop) => stop());
		};
	}, []);

	useEffect(() => {
		reload();
		const off = listen("hosts-changed", reload);
		return () => {
			off.then((stop) => stop());
		};
	}, [reload]);

	const add = async () => {
		setBusy(true);
		setError(null);
		try {
			await hostsApi.add(name.trim() || destination.trim(), {
				kind: "ssh",
				destination: destination.trim(),
				...(server.trim() ? { server: server.trim() } : {}),
			});
			setName("");
			setDestination("");
			setServer("");
			reload();
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	};

	const remove = async (id: string) => {
		setRemoving(null);
		await hostsApi.remove(id).catch((e) => setError(String(e)));
		reload();
	};

	const uninstall = async (host: HostEntry) => {
		setConfirmUninstall(null);
		setRemoving(null);
		setWorking((w) => ({ ...w, [host.id]: REMOVING }));
		try {
			await hostsApi.uninstall(host.id);
			await remove(host.id);
		} catch (e) {
			setChecks((c) => ({ ...c, [host.id]: { error: String(e) } }));
		} finally {
			setWorking(({ [host.id]: _, ...rest }) => rest);
		}
	};

	return (
		<div className="flex flex-col gap-5 flex-1 min-h-0 overflow-y-auto">
			{confirmRestart && (
				<ConfirmDialog
					title="End the running panes?"
					message={confirmRestart.message}
					confirmLabel="Restart the server"
					confirmVariant="danger"
					onConfirm={() => {
						const { id, last, action } = confirmRestart;
						setConfirmRestart(null);
						void runAction(id, last, action);
					}}
					onCancel={() => setConfirmRestart(null)}
				/>
			)}
			{confirmUninstall && (
				<ConfirmDialog
					title={`Uninstall the server from ${confirmUninstall.name}?`}
					message="This stops the server, ending every pane and Agent it runs, and deletes ~/.abundio-server on the Host: the server and its data (the Host's Profiles, Workspaces, layouts and notes). Your project folders there are not touched."
					confirmLabel="Uninstall"
					confirmVariant="danger"
					onConfirm={() => void uninstall(confirmUninstall)}
					onCancel={() => setConfirmUninstall(null)}
				/>
			)}
			<div>
				<SectionLabel>Hosts</SectionLabel>
				<p
					style={{
						fontSize: 12,
						color: "var(--fg-secondary)",
						marginBottom: 12,
					}}
				>
					A Host runs an Abundio server, so its Agents keep working while this
					computer sleeps. Abundio reaches it with your own ssh: keys,
					~/.ssh/config, jump hosts. Check shows what the Host needs, and
					Install puts the server in ~/.abundio-server there, no root needed.
					Then use File ▸ Open Remote Profile….
				</p>
				{hosts.length === 0 ? (
					<div style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
						No Hosts yet.
					</div>
				) : (
					<div
						className="flex flex-col rounded-lg overflow-hidden"
						style={{ border: "1px solid var(--border)" }}
					>
						{hosts.map((h, i) => (
							<div
								key={h.id}
								className="flex flex-col gap-3"
								style={{
									padding: "10px 12px",
									borderTop: i === 0 ? "none" : "1px solid var(--border)",
									backgroundColor: "var(--bg-primary)",
								}}
							>
								<div className="flex items-center gap-3">
									<div className="flex flex-col flex-1 min-w-0">
										<span style={{ fontSize: 13, color: "var(--fg-primary)" }}>
											{h.name}
										</span>
										<span
											className="truncate"
											style={{
												fontSize: 11,
												color: "var(--fg-secondary)",
												fontFamily: "var(--font-mono)",
											}}
										>
											{h.target.kind === "ssh"
												? `ssh ${h.target.destination}`
												: h.target.server}
										</span>
									</div>
									<button
										type="button"
										className={`${secondaryButtonClass} rounded-md`}
										style={{ fontSize: 12, height: 28, padding: "0 10px" }}
										disabled={checks[h.id] === "checking"}
										onClick={() => void check(h.id)}
									>
										{checks[h.id] === "checking" ? "Checking…" : "Check"}
									</button>
									<button
										type="button"
										className={`${secondaryButtonClass} rounded-md`}
										style={{ fontSize: 12, height: 28, padding: "0 10px" }}
										disabled={working[h.id] !== undefined}
										onClick={() => setRemoving(removing === h.id ? null : h.id)}
									>
										{working[h.id] === REMOVING ? "Removing…" : "Remove"}
									</button>
								</div>
								{removing === h.id && (
									<div
										className="flex flex-col gap-2 rounded-md"
										style={{
											padding: "10px 12px",
											border: "1px solid var(--border)",
											fontSize: 12,
											color: "var(--fg-secondary)",
										}}
									>
										<span>
											Remove {h.name} from this list only, or also uninstall the
											server from the Host?
										</span>
										<div className="flex gap-2">
											<button
												type="button"
												className={`${secondaryButtonClass} rounded-md`}
												style={{ fontSize: 12, height: 26, padding: "0 10px" }}
												onClick={() => void remove(h.id)}
											>
												Remove from list
											</button>
											<button
												type="button"
												className={`${secondaryButtonClass} rounded-md`}
												style={{ fontSize: 12, height: 26, padding: "0 10px" }}
												onClick={() => setConfirmUninstall(h)}
											>
												Uninstall from the Host too…
											</button>
											<button
												type="button"
												className={`${secondaryButtonClass} rounded-md`}
												style={{ fontSize: 12, height: 26, padding: "0 10px" }}
												onClick={() => setRemoving(null)}
											>
												Cancel
											</button>
										</div>
									</div>
								)}
								<HostCheckResult
									result={checks[h.id]}
									busy={working[h.id] ?? null}
									onAction={(action) => {
										const last = checks[h.id];
										if (last && last !== "checking" && !("error" in last))
											askAction(h, last, action);
									}}
								/>
							</div>
						))}
					</div>
				)}
			</div>

			<div>
				<SectionLabel>Add a Host</SectionLabel>
				<div className="flex flex-col gap-2" style={{ maxWidth: 420 }}>
					<input
						className="rounded-md"
						style={paramTextInputStyle}
						placeholder="ssh destination: an alias from ~/.ssh/config, or user@host"
						value={destination}
						onChange={(e) => setDestination(e.target.value)}
						spellCheck={false}
						autoCapitalize="off"
					/>
					<input
						className="rounded-md"
						style={paramTextInputStyle}
						placeholder="Name (optional; the destination by default)"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
					<input
						className="rounded-md"
						style={paramTextInputStyle}
						placeholder="Server program on the Host (optional; the one Install puts in ~/.abundio-server)"
						value={server}
						onChange={(e) => setServer(e.target.value)}
						spellCheck={false}
						autoCapitalize="off"
					/>
					{error && (
						<div style={{ fontSize: 12, color: "var(--error)" }}>{error}</div>
					)}
					<div>
						<button
							type="button"
							className={`${primaryButtonClass} rounded-md`}
							style={{
								fontSize: 12,
								height: 30,
								padding: "0 14px",
								color: "white",
								backgroundColor: "var(--accent)",
								opacity: destination.trim() && !busy ? 1 : 0.5,
							}}
							disabled={!destination.trim() || busy}
							onClick={() => void add()}
						>
							Add Host
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

function HostCheckResult({
	result,
	busy,
	onAction,
}: {
	result: HostCheck | { error: string } | "checking" | undefined;
	busy: string | null;
	onAction: (action: NonNullable<HostCheck["items"][number]["action"]>) => void;
}) {
	if (!result || result === "checking") return null;
	if ("error" in result)
		return (
			<div
				style={{
					fontSize: 12,
					color: "var(--error)",
					whiteSpace: "pre-wrap",
					userSelect: "text",
				}}
			>
				{result.error}
			</div>
		);
	return <HostChecklist check={result} busy={busy} onAction={onAction} />;
}
