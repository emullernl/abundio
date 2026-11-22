import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { copyableAgents, copyOf } from "../../lib/copyAgents";
import type { HostSettings } from "../../lib/hostSettings";
import { type HostEntry, hostsApi, joinedApi } from "../../lib/ipc";
import type { CodingAgent } from "../../lib/types";
import { useSettingsStore } from "../../stores/settingsStore";
import {
	primaryButtonClass,
	secondaryButtonClass,
} from "../PromptActions/fieldStyles";
import { Select } from "../PromptActions/Select";

/**
 * "Copy from…" (ADR-0064): pick custom Agents of another Host (this
 * computer included) to add to the one being edited. Only those it does not
 * have yet; each copy gets an id of its own.
 */
export function CopyAgentsDialog({
	target,
	have,
	onCopy,
	onClose,
}: {
	/** The Host being edited; `null`: this computer. */
	target: string | null;
	have: CodingAgent[];
	onCopy: (agents: CodingAgent[]) => Promise<void> | void;
	onClose: () => void;
}) {
	useEscapeKey(onClose);
	const [hosts, setHosts] = useState<HostEntry[]>([]);
	const [source, setSource] = useState<string>(target === null ? "" : "local");
	const [offered, setOffered] = useState<CodingAgent[] | null>(null);
	const [picked, setPicked] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void hostsApi
			.list()
			.then(setHosts)
			.catch(() => setHosts([]));
	}, []);

	const sources = [
		...(target === null ? [] : [{ value: "local", label: "This computer" }]),
		...hosts
			.filter((h) => h.id !== target)
			.map((h) => ({ value: h.id, label: h.name })),
	];

	useEffect(() => {
		if (!source) return;
		setOffered(null);
		setPicked(new Set());
		setError(null);
		const read =
			source === "local"
				? Promise.resolve(useSettingsStore.getState().agents)
				: joinedApi
						.attach(source, true)
						.then(() =>
							joinedApi.callOn<HostSettings | null>(
								source,
								"host_settings_get",
								{},
							),
						)
						.then((s) => s?.customAgents ?? []);
		read
			.then((list) => setOffered(copyableAgents(list, have)))
			.catch((e) => setError(String(e)));
	}, [source, have]);

	return createPortal(
		<div
			role="presentation"
			className="fixed inset-0 z-[200] flex items-center justify-center"
			style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
		>
			<div
				role="dialog"
				aria-label="Copy agents from another Host"
				className="rounded-2xl flex flex-col gap-3"
				style={{
					width: 440,
					padding: "20px 22px",
					backgroundColor: "var(--bg-secondary)",
					border: "1px solid var(--border)",
					boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
				}}
				onKeyDown={(e) => e.stopPropagation()}
			>
				<h2
					className="font-semibold"
					style={{ fontSize: 15, color: "var(--fg-primary)" }}
				>
					Copy custom agents from…
				</h2>
				{sources.length === 0 ? (
					<p style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
						There is no other Host to copy from.
					</p>
				) : (
					<Select
						value={source}
						options={[{ value: "", label: "Pick a Host" }, ...sources]}
						onChange={setSource}
					/>
				)}
				{error && (
					<div style={{ fontSize: 12, color: "var(--error)" }}>{error}</div>
				)}
				{source && offered === null && !error && (
					<p style={{ fontSize: 12, color: "var(--fg-secondary)" }}>Reading…</p>
				)}
				{offered && offered.length === 0 && (
					<p style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
						Nothing to copy: no custom agent there that this one lacks.
					</p>
				)}
				{offered && offered.length > 0 && (
					<div className="flex flex-col gap-1">
						{offered.map((a) => (
							<label
								key={a.id}
								className="flex items-center gap-2"
								style={{ fontSize: 12 }}
							>
								<input
									type="checkbox"
									checked={picked.has(a.id)}
									onChange={(e) =>
										setPicked((p) => {
											const next = new Set(p);
											if (e.target.checked) next.add(a.id);
											else next.delete(a.id);
											return next;
										})
									}
								/>
								<span style={{ color: "var(--fg-primary)" }}>{a.name}</span>
								<code style={{ color: "var(--fg-secondary)" }}>
									{a.command}
								</code>
							</label>
						))}
					</div>
				)}
				<div className="flex justify-end gap-2">
					<button
						type="button"
						className={`${secondaryButtonClass} rounded-md`}
						style={{ fontSize: 12, height: 30, padding: "0 14px" }}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						type="button"
						className={`${primaryButtonClass} rounded-md`}
						style={{
							fontSize: 12,
							height: 30,
							padding: "0 14px",
							color: "white",
							backgroundColor: "var(--accent)",
						}}
						disabled={picked.size === 0}
						onClick={async () => {
							const chosen = (offered ?? [])
								.filter((a) => picked.has(a.id))
								.map(copyOf);
							await onCopy(chosen);
							onClose();
						}}
					>
						Copy {picked.size > 0 ? picked.size : ""}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
