import { motion } from "framer-motion";
import { Cloud } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { type HostEntry, hostsApi, settingsWindow } from "../lib/ipc";
import type { Profile } from "../lib/types";
import { useJoinedStore } from "../stores/joinedStore";
import {
	paramTextInputStyle,
	primaryButtonClass,
	secondaryButtonClass,
} from "./PromptActions/fieldStyles";

/**
 * File ▸ Open Remote Profile… (docs/plans/remote-hosts.md phase 7d): pick a
 * Host, connect to it with the user's ssh, then open one of its Profiles (or
 * a new one) in a Window of its own. The server must already run there
 * until phase 8 installs it.
 */
export function OpenRemoteProfileDialog({
	onClose,
	mode = "open",
}: {
	onClose: () => void;
	/** `join`: show the picked Profile in this Window's Profile, in a section
	 *  of its own (a **Joined profile**, phase 10), instead of opening it in a
	 *  Window of its own. */
	mode?: "open" | "join";
}) {
	const [hosts, setHosts] = useState<HostEntry[] | null>(null);
	const [hostId, setHostId] = useState<string | null>(null);
	const [phase, setPhase] = useState<"pick" | "connecting" | "profiles">(
		"pick",
	);
	const [profiles, setProfiles] = useState<Profile[]>([]);
	const [newName, setNewName] = useState("");
	const [error, setError] = useState<string | null>(null);
	useEscapeKey(onClose);

	useEffect(() => {
		hostsApi
			.list()
			.then((list) => {
				setHosts(list);
				setHostId(list[0]?.id ?? null);
			})
			.catch((e) => setError(String(e)));
	}, []);

	const connect = async () => {
		if (!hostId) return;
		setPhase("connecting");
		setError(null);
		try {
			await hostsApi.connectSaved(hostId);
			const list = await hostsApi.request<Profile[]>(
				hostId,
				"server_profile_list",
				{},
			);
			setProfiles(list);
			setPhase("profiles");
		} catch (e) {
			setError(String(e));
			setPhase("pick");
		}
	};

	const open = async (p: Profile) => {
		if (!hostId) return;
		try {
			if (mode === "join") {
				await useJoinedStore
					.getState()
					.join(hostId, { id: p.id, name: p.name });
			} else {
				await hostsApi.openRemoteProfile(hostId, p.id, p.name);
			}
			onClose();
		} catch (e) {
			setError(String(e));
		}
	};

	const create = async () => {
		if (!hostId || !newName.trim()) return;
		try {
			const p = await hostsApi.request<Profile>(
				hostId,
				"server_profile_create",
				{ name: newName.trim() },
			);
			await open(p);
		} catch (e) {
			setError(String(e));
		}
	};

	const host = hosts?.find((h) => h.id === hostId);

	return createPortal(
		<motion.div
			role="presentation"
			className="fixed inset-0 z-[200] flex items-center justify-center"
			style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
			onClick={onClose}
		>
			<motion.div
				role="dialog"
				aria-label={
					mode === "join" ? "Join Remote Profile" : "Open Remote Profile"
				}
				className="rounded-2xl flex flex-col gap-4"
				initial={{ opacity: 0, scale: 0.95, y: 10 }}
				animate={{ opacity: 1, scale: 1, y: 0 }}
				transition={{ duration: 0.15, ease: [0.2, 0, 0, 1] }}
				style={{
					width: 460,
					padding: "22px 24px",
					backgroundColor: "var(--bg-secondary)",
					border: "1px solid var(--border)",
					boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
				}}
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => e.stopPropagation()}
			>
				<div className="flex items-center gap-2">
					<Cloud size={16} style={{ color: "var(--accent)" }} />
					<h2
						className="font-semibold"
						style={{ fontSize: 15, color: "var(--fg-primary)" }}
					>
						{mode === "join" ? "Join Remote Profile" : "Open Remote Profile"}
					</h2>
				</div>

				{hosts !== null && hosts.length === 0 && (
					<div className="flex flex-col gap-3">
						<p style={{ fontSize: 13, color: "var(--fg-secondary)" }}>
							Add a Host first: the ssh alias or user@host of a machine running
							an Abundio server.
						</p>
						<div>
							<button
								type="button"
								className={`${secondaryButtonClass} rounded-md`}
								style={{ fontSize: 12, height: 30, padding: "0 12px" }}
								onClick={() => {
									void settingsWindow.open("hosts");
									onClose();
								}}
							>
								Open Settings ▸ Hosts
							</button>
						</div>
					</div>
				)}

				{hosts && hosts.length > 0 && phase !== "profiles" && (
					<div className="flex flex-col gap-2">
						{hosts.map((h) => (
							<label
								key={h.id}
								className="flex items-center gap-3 rounded-md cursor-pointer"
								style={{
									padding: "8px 10px",
									border: `1px solid ${h.id === hostId ? "var(--accent)" : "var(--border)"}`,
									backgroundColor: "var(--bg-primary)",
								}}
							>
								<input
									type="radio"
									name="host"
									checked={h.id === hostId}
									onChange={() => setHostId(h.id)}
								/>
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
									{h.target.kind === "ssh" ? h.target.destination : "local"}
								</span>
							</label>
						))}
					</div>
				)}

				{phase === "profiles" && (
					<div className="flex flex-col gap-2">
						<div style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
							Profiles on {host?.name}
						</div>
						{profiles.map((p) => (
							<button
								key={p.id}
								type="button"
								className={`${secondaryButtonClass} rounded-md`}
								style={{
									justifyContent: "flex-start",
									fontSize: 13,
									height: 34,
									padding: "0 12px",
								}}
								onClick={() => void open(p)}
							>
								{p.name}
							</button>
						))}
						<div className="flex gap-2" style={{ marginTop: 6 }}>
							<input
								className="rounded-md"
								style={paramTextInputStyle}
								placeholder="New Profile on this Host"
								value={newName}
								onChange={(e) => setNewName(e.target.value)}
								onKeyDown={(e) => e.key === "Enter" && void create()}
							/>
							<button
								type="button"
								className={`${secondaryButtonClass} rounded-md`}
								style={{ fontSize: 12, height: 36, padding: "0 12px" }}
								disabled={!newName.trim()}
								onClick={() => void create()}
							>
								Create
							</button>
						</div>
					</div>
				)}

				{error && (
					<div
						style={{
							fontSize: 12,
							color: "var(--error)",
							whiteSpace: "pre-wrap",
						}}
					>
						{error}
					</div>
				)}

				<div className="flex justify-end gap-2">
					<button
						type="button"
						className={`${secondaryButtonClass} rounded-md`}
						style={{ fontSize: 12, height: 30, padding: "0 12px" }}
						onClick={onClose}
					>
						Cancel
					</button>
					{hosts && hosts.length > 0 && phase !== "profiles" && (
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
							disabled={!hostId || phase === "connecting"}
							onClick={() => void connect()}
						>
							{phase === "connecting" ? "Connecting…" : "Connect"}
						</button>
					)}
				</div>
			</motion.div>
		</motion.div>,
		document.body,
	);
}
