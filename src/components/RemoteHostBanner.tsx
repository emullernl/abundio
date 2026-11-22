import { CloudOff, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import {
	hostsApi,
	listen,
	listenToThisWindow,
	settingsWindow,
} from "../lib/ipc";
import { isMac } from "../lib/platform";
import { serverUpdateTitle, serverVersionMismatch } from "../lib/serverVersion";
import { unsavedFilePaths } from "../lib/unsavedFiles";
import { useExplorerStore } from "../stores/explorerStore";
import { useHostLinkStore } from "../stores/hostLinkStore";
import { useProfileStore } from "../stores/profileStore";
import { primaryButtonClass } from "./PromptActions/fieldStyles";

/** Below the macOS title bar strip (fixed, drawn over the layout). */
const TOP = (isMac ? 28 : 0) + 10;

/**
 * A remote Window's link to its Host (docs/plans/remote-hosts.md phase 7d).
 * While it is down the panes are frozen (keystrokes dropped) and this says
 * so: "Reconnecting to <host>…" while Rust retries in the background, or
 * "Sign in needed" for a Host that wants a password, passphrase, 2FA or a
 * host key, which ssh is never allowed to ask for in the background.
 *
 * Once connected again the Window reloads, the same path as app start, so
 * every pane catches up from the Host's output log and every status is the
 * Host's. A Window with unsaved edits asks first instead.
 */
export function RemoteHostBanner() {
	const remote = useProfileStore((s) => s.remote);
	const link = useHostLinkStore((s) => s.link);
	const [busy, setBusy] = useState(false);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!remote) return;
		const apply = useHostLinkStore.getState().apply;
		const loadError = useProfileStore.getState().remoteError;
		if (loadError) apply({ kind: "failed", reason: loadError, signIn: false });
		const mine = (host: string) => host === remote.hostId;
		const offs = [
			listenToThisWindow<{ host: string; reason: string }>(
				"host-connection-lost",
				(e) => {
					if (mine(e.payload.host))
						apply({ kind: "lost", reason: e.payload.reason });
				},
			),
			listenToThisWindow<{
				host: string;
				reason: string;
				signIn: boolean;
				retryInMs: number | null;
			}>("host-reconnecting", (e) => {
				if (!mine(e.payload.host)) return;
				apply({
					kind: "retrying",
					reason: e.payload.reason,
					signIn: e.payload.signIn,
					retryInMs: e.payload.retryInMs,
					now: Date.now(),
				});
			}),
			listenToThisWindow<{ host: string; reason: string; signIn?: boolean }>(
				"host-connect-failed",
				(e) => {
					if (!mine(e.payload.host)) return;
					apply({
						kind: "failed",
						reason: e.payload.reason,
						signIn: e.payload.signIn ?? true,
					});
				},
			),
			// Its server was just updated (Settings ▸ Hosts): connect again.
			listen<string>("host-server-ready", (e) => {
				if (!mine(e.payload)) return;
				if (useHostLinkStore.getState().link.state !== "online")
					void hostsApi.connectSaved(remote.hostId).catch(() => {});
			}),
			listenToThisWindow<{ host: string }>("host-connected", (e) => {
				if (!mine(e.payload.host)) return;
				const loaded = !useProfileStore.getState().remoteError;
				const unsaved =
					unsavedFilePaths(useExplorerStore.getState().filePanes).length > 0;
				if (loaded && unsaved) {
					apply({ kind: "connected", caughtUp: false });
					return;
				}
				window.location.reload();
			}),
		];
		return () => {
			for (const off of offs) off.then((stop) => stop());
		};
	}, [remote]);

	const retryAt = link.state === "offline" ? link.retryAt : null;
	useEffect(() => {
		if (retryAt === null) return;
		const t = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(t);
	}, [retryAt]);

	if (!remote || link.state === "online") return null;

	const connectNow = async () => {
		setBusy(true);
		try {
			await hostsApi.connectSaved(remote.hostId);
		} catch (e) {
			useHostLinkStore
				.getState()
				.apply({ kind: "failed", reason: String(e), signIn: false });
		} finally {
			setBusy(false);
		}
	};

	const mismatch =
		link.state === "offline" ? serverVersionMismatch(link.reason ?? "") : null;
	let title: string;
	let detail: string | null = null;
	let action: string;
	let onAction: () => void;
	if (link.state === "back") {
		title = `Connected to ${remote.hostName} again.`;
		detail = "Save your files, then reload to catch up.";
		action = "Reload";
		onAction = () => window.location.reload();
	} else if (mismatch) {
		// Another server version: only an update in Settings fixes it.
		title = serverUpdateTitle(remote.hostName, mismatch);
		detail = "Update it in Settings ▸ Hosts.";
		action = "Open Settings";
		onAction = () => void settingsWindow.checkHost(remote.hostId);
	} else {
		if (link.signIn) {
			title = `Not connected to ${remote.hostName}. Sign in needed.`;
			action = "Sign in";
		} else if (link.retryAt !== null) {
			const s = Math.max(0, Math.ceil((link.retryAt - now) / 1000));
			title = `Reconnecting to ${remote.hostName}… next try in ${s}s`;
			action = "Try now";
		} else {
			title = `Not connected to ${remote.hostName}.`;
			action = "Connect";
		}
		detail = link.reason;
		onAction = () => void connectNow();
	}

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
			{link.state === "back" ? (
				<RefreshCw
					size={16}
					style={{ flexShrink: 0, color: "var(--warning, #d29922)" }}
				/>
			) : (
				<CloudOff
					size={16}
					style={{ flexShrink: 0, color: "var(--warning, #d29922)" }}
				/>
			)}
			<div className="flex flex-col flex-1 min-w-0">
				<span>{title}</span>
				{detail && (
					<span
						className="truncate"
						title={detail}
						style={{ fontSize: 11, color: "var(--fg-secondary)" }}
					>
						{detail}
					</span>
				)}
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
				disabled={busy}
				onClick={onAction}
			>
				{busy ? "Connecting…" : action}
			</button>
		</div>
	);
}
