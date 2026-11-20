import { useCallback, useEffect, useState } from "react";
import { type HostEntry, hostsApi, listen } from "../../lib/ipc";
import {
	paramTextInputStyle,
	primaryButtonClass,
	secondaryButtonClass,
} from "../PromptActions/fieldStyles";
import { SectionLabel } from "./primitives";

/**
 * Settings ▸ Hosts (docs/plans/remote-hosts.md phase 7d): the machines an
 * Abundio server runs on, reached with the user's own `ssh`. Adding one
 * only remembers how to reach it; File ▸ Open Remote Profile… connects.
 * Until phase 8 installs the server, it is started on the Host by hand.
 */
export function HostsSection() {
	const [hosts, setHosts] = useState<HostEntry[]>([]);
	const [name, setName] = useState("");
	const [destination, setDestination] = useState("");
	const [server, setServer] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const reload = useCallback(() => {
		hostsApi
			.list()
			.then(setHosts)
			.catch(() => setHosts([]));
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
		await hostsApi.remove(id).catch((e) => setError(String(e)));
		reload();
	};

	return (
		<div className="flex flex-col gap-5 flex-1 min-h-0 overflow-y-auto">
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
					~/.ssh/config, jump hosts. Start the server there with{" "}
					<code style={{ fontFamily: "var(--font-mono)" }}>
						abundio-server run
					</code>
					, then use File ▸ Open Remote Profile….
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
								className="flex items-center gap-3"
								style={{
									padding: "10px 12px",
									borderTop: i === 0 ? "none" : "1px solid var(--border)",
									backgroundColor: "var(--bg-primary)",
								}}
							>
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
									onClick={() => void remove(h.id)}
								>
									Remove
								</button>
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
						placeholder="Server program on the Host (optional; abundio-server on its PATH)"
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
