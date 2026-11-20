import { CloudOff } from "lucide-react";
import { useEffect, useState } from "react";
import { hostsApi, listenToThisWindow } from "../lib/ipc";
import { isMac } from "../lib/platform";
import { useProfileStore } from "../stores/profileStore";
import { primaryButtonClass } from "./PromptActions/fieldStyles";

/**
 * A remote Window whose Host is not connected (phase 7d): at app start ssh
 * never asks, so a Host that needs a password, a passphrase or 2FA says
 * "Sign in needed" here instead of raising a prompt. Sign in connects with
 * Abundio's SSH dialog; the Window loads again once connected.
 */
/** Below the macOS title bar strip (fixed, drawn over the layout). */
const TOP = (isMac ? 28 : 0) + 10;

export function RemoteHostBanner() {
	const remote = useProfileStore((s) => s.remote);
	const error = useProfileStore((s) => s.remoteError);
	const [reason, setReason] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!remote) return;
		const off = listenToThisWindow<{ host: string; reason: string }>(
			"host-connect-failed",
			(event) => {
				if (event.payload.host === remote.hostId)
					setReason(event.payload.reason);
			},
		);
		return () => {
			off.then((stop) => stop());
		};
	}, [remote]);

	if (!remote || !error) return null;

	const signIn = async () => {
		setBusy(true);
		try {
			await hostsApi.connectSaved(remote.hostId);
		} catch (e) {
			setReason(String(e));
		} finally {
			setBusy(false);
		}
	};

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
				<span>Not connected to {remote.hostName}. Sign in needed.</span>
				{reason && (
					<span
						className="truncate"
						title={reason}
						style={{ fontSize: 11, color: "var(--fg-secondary)" }}
					>
						{reason}
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
				onClick={() => void signIn()}
			>
				{busy ? "Connecting…" : "Sign in"}
			</button>
		</div>
	);
}
