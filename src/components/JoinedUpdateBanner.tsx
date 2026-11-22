import { CloudOff } from "lucide-react";
import { useEffect } from "react";
import { listen, settingsWindow } from "../lib/ipc";
import { isMac } from "../lib/platform";
import { serverUpdateTitle, serverVersionMismatch } from "../lib/serverVersion";
import { useJoinedStore } from "../stores/joinedStore";
import { useProfileStore } from "../stores/profileStore";
import { primaryButtonClass } from "./PromptActions/fieldStyles";

const TOP = (isMac ? 28 : 0) + 10;

/**
 * A Joined profile whose Host runs another server version than this app
 * (the handshake refuses it): a banner that opens Settings ▸ Hosts on that
 * Host's checklist, where Update installs this app's version. Once the
 * server is ready the Host is connected again by itself.
 */
export function JoinedUpdateBanner() {
	const remote = useProfileStore((s) => s.remote);
	const entries = useJoinedStore((s) => s.entries);
	const links = useJoinedStore((s) => s.links);

	useEffect(() => {
		const off = listen<string>("host-server-ready", (e) => {
			const { links, signIn } = useJoinedStore.getState();
			if (links[e.payload]?.state === "offline") void signIn(e.payload);
		});
		return () => {
			void off.then((stop) => stop());
		};
	}, []);

	// A remote Window says it in its own banner.
	if (remote) return null;
	const stale = entries.flatMap((e) => {
		const link = links[e.hostId];
		const v =
			link?.state === "offline" ? serverVersionMismatch(link.reason) : null;
		return v ? [{ entry: e, v }] : [];
	});
	const first = stale[0];
	if (!first) return null;
	const others = stale.length - 1;

	return (
		<div
			role="status"
			className="fixed z-[60] flex items-center gap-3 rounded-lg"
			style={{
				top: TOP,
				left: "50%",
				transform: "translateX(-50%)",
				width: "min(560px, calc(100vw - 32px))",
				padding: "10px 12px 10px 14px",
				backgroundColor:
					"color-mix(in srgb, var(--warning, #d29922) 18%, var(--bg-secondary))",
				border:
					"1px solid color-mix(in srgb, var(--warning, #d29922) 55%, transparent)",
				boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
				fontSize: 12,
				color: "var(--fg-primary)",
			}}
		>
			<CloudOff
				size={16}
				style={{ flexShrink: 0, color: "var(--warning, #d29922)" }}
			/>
			<div className="flex flex-col flex-1 min-w-0">
				<span>{serverUpdateTitle(first.entry.hostName, first.v)}</span>
				<span style={{ fontSize: 11, color: "var(--fg-secondary)" }}>
					{first.entry.remoteProfileName} stays offline until it is updated in
					Settings ▸ Hosts.
					{others > 0 &&
						` ${others} more Host${others === 1 ? "" : "s"} need${others === 1 ? "s" : ""} it too.`}
				</span>
			</div>
			<button
				type="button"
				className={`${primaryButtonClass} rounded-md`}
				style={{
					flexShrink: 0,
					fontSize: 12,
					height: 26,
					padding: "0 12px",
					color: "white",
					backgroundColor: "var(--accent)",
				}}
				onClick={() => void settingsWindow.checkHost(first.entry.hostId)}
			>
				Open Settings
			</button>
		</div>
	);
}
