import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-shell";
import { useEffect, useState } from "react";
import { updates as updatesIpc } from "../../lib/ipc";
import { useSettingsStore } from "../../stores/settingsStore";
import { releaseNotesUrl, useUpdateStore } from "../../stores/updateStore";
import { ConfirmDialog } from "../ConfirmDialog";
import { SectionLabel, ToggleRow } from "./primitives";

export function UpdatesSection() {
	const status = useUpdateStore((s) => s.status);
	const info = useUpdateStore((s) => s.info);
	const error = useUpdateStore((s) => s.error);
	const downloaded = useUpdateStore((s) => s.downloaded);
	const total = useUpdateStore((s) => s.total);
	const check = useUpdateStore((s) => s.check);
	const download = useUpdateStore((s) => s.download);
	const installNow = useUpdateStore((s) => s.installNow);
	const hydrate = useUpdateStore((s) => s.hydrate);
	const [confirmRestart, setConfirmRestart] = useState(false);
	const autoCheck = useSettingsStore((s) => s.autoCheckUpdatesEnabled);
	const setAutoCheck = useSettingsStore((s) => s.setAutoCheckUpdatesEnabled);

	const setProgress = useUpdateStore((s) => s.setProgress);

	const [currentVersion, setCurrentVersion] = useState<string>("");
	useEffect(() => {
		getVersion()
			.then(setCurrentVersion)
			.catch(() => setCurrentVersion(""));
	}, []);

	// The Settings window is its own JS context and its store starts empty, so
	// adopt the app-global Rust updater state on mount — otherwise a download
	// started from a Profile Window's prompt is invisible here, and clicking
	// "Check for updates" would re-download a bundle we already have staged.
	// Unlike the prompt, this hydrate ignores skip/snooze: this is a status
	// display, and it already renders its own "Snoozed until…" row.
	useEffect(() => {
		hydrate({ respectSuppression: false });
	}, [hydrate]);

	// The Settings window is its own JS context, so it needs its own progress
	// listener for downloads kicked off from here (the Rust emit is global).
	useEffect(() => {
		const unlisten = updatesIpc.onDownloadProgress(({ downloaded, total }) => {
			setProgress(downloaded, total);
		});
		return () => {
			unlisten.then((fn) => fn()).catch(() => {});
		};
	}, [setProgress]);

	const pct =
		total && total > 0
			? Math.min(100, Math.round((downloaded / total) * 100))
			: null;

	const statusText = (() => {
		switch (status) {
			case "checking":
				return "Checking for updates…";
			case "uptodate":
				return "You're up to date.";
			case "available":
				return info
					? `Version ${info.version} is available.`
					: "Update available.";
			case "downloading":
				return `Downloading…${pct != null ? ` ${pct}%` : ""}`;
			case "ready":
				return "Update downloaded. It installs the next time you quit Abundio — or restart now.";
			case "error":
				return error ? `Update check failed: ${error}` : "Update check failed.";
			default:
				return "";
		}
	})();

	const busy = status === "checking" || status === "downloading";

	// Update-prompt suppression (ADR-0014) was set-only: "Skip this version" and
	// "Later" had no undo anywhere in the UI. Evaluated at render — the page
	// mounts on a nav click, so a snooze that lapses while it is open simply
	// disappears the next time you come back. No timer.
	const skippedVersion = useSettingsStore((s) => s.skippedUpdateVersion);
	const snoozedUntil = useSettingsStore((s) => s.updateSnoozedUntil);
	const setSkippedVersion = useSettingsStore((s) => s.setSkippedUpdateVersion);
	const setSnoozedUntil = useSettingsStore((s) => s.setUpdateSnoozedUntil);
	const snoozeActive = snoozedUntil != null && snoozedUntil > Date.now();
	const suppression = skippedVersion
		? `Skipping v${skippedVersion}`
		: snoozeActive && snoozedUntil != null
			? `Snoozed until ${new Date(snoozedUntil).toLocaleString()}`
			: null;

	return (
		<>
			<div className="flex flex-col gap-5 flex-1 min-h-0 overflow-y-auto">
				<div>
					<SectionLabel>Version</SectionLabel>
					<div
						className="flex items-center justify-between rounded-lg"
						style={{
							padding: "12px 14px",
							backgroundColor: "var(--bg-primary)",
							border: "1px solid var(--border)",
						}}
					>
						<div>
							<div style={{ fontSize: 13, color: "var(--fg-primary)" }}>
								Abundio
							</div>
							<div
								className="font-mono"
								style={{
									fontSize: 11,
									color: "var(--fg-secondary)",
									marginTop: 2,
								}}
							>
								{currentVersion ? `v${currentVersion}` : "—"}
							</div>
						</div>
						{status === "ready" ? (
							<button
								type="button"
								onClick={() => setConfirmRestart(true)}
								className="rounded-md transition-colors font-medium"
								style={{
									fontSize: 12,
									padding: "7px 12px",
									color: "var(--fg-primary)",
									backgroundColor: "var(--bg-tertiary)",
									border: "1px solid var(--border)",
								}}
							>
								Restart now
							</button>
						) : status === "available" ? (
							<button
								type="button"
								onClick={() => download()}
								className="rounded-md transition-colors font-medium"
								style={{
									fontSize: 12,
									padding: "7px 12px",
									color: "white",
									backgroundColor: "var(--accent)",
								}}
							>
								Install update
							</button>
						) : (
							<button
								type="button"
								onClick={() => check({ manual: true })}
								disabled={busy}
								className="rounded-md transition-colors"
								style={{
									fontSize: 12,
									padding: "7px 12px",
									color: busy ? "var(--fg-secondary)" : "var(--fg-primary)",
									backgroundColor: "var(--bg-tertiary)",
									border: "1px solid var(--border)",
									cursor: busy ? "default" : "pointer",
									opacity: busy ? 0.6 : 1,
								}}
							>
								{status === "checking" ? "Checking…" : "Check for updates"}
							</button>
						)}
					</div>
					{statusText && (
						<div
							style={{
								fontSize: 12,
								color:
									status === "error" ? "var(--error)" : "var(--fg-secondary)",
								marginTop: 8,
								lineHeight: 1.5,
							}}
						>
							{statusText}
						</div>
					)}
					{(status === "available" ||
						status === "downloading" ||
						status === "ready") &&
						info && (
							<button
								type="button"
								onClick={() =>
									open(releaseNotesUrl(info.version)).catch(() => {})
								}
								className="text-left transition-colors"
								style={{
									fontSize: 12,
									color: "var(--accent)",
									marginTop: 6,
									background: "transparent",
									border: "none",
									padding: 0,
									cursor: "pointer",
								}}
							>
								View release notes ↗
							</button>
						)}
					{status === "downloading" && (
						<div
							className="rounded-full overflow-hidden"
							style={{
								height: 4,
								marginTop: 8,
								backgroundColor: "var(--bg-tertiary)",
							}}
						>
							<div
								style={{
									height: "100%",
									width: pct != null ? `${pct}%` : "40%",
									backgroundColor: "var(--accent)",
									borderRadius: 999,
									transition: "width 0.2s",
								}}
							/>
						</div>
					)}
				</div>

				<div>
					<SectionLabel>Automatic Updates</SectionLabel>
					<ToggleRow
						checked={autoCheck}
						onChange={setAutoCheck}
						label="Automatically check for updates"
						description="Checks on launch and periodically. Updates download in the background and install the next time you quit — your running terminals and agents are never interrupted."
					/>
				</div>

				{suppression && (
					<div>
						<SectionLabel>Notifications</SectionLabel>
						<div
							className="flex items-center gap-3 rounded-lg"
							style={{
								padding: "10px 12px",
								backgroundColor: "var(--bg-primary)",
								border: "1px solid var(--border)",
							}}
						>
							<div className="flex-1 min-w-0">
								<div
									style={{
										fontSize: 13,
										color: "var(--fg-primary)",
										lineHeight: 1.3,
									}}
								>
									{suppression}
								</div>
								<div
									style={{
										fontSize: 11,
										color: "var(--fg-secondary)",
										marginTop: 2,
										lineHeight: 1.4,
									}}
								>
									Update prompts are suppressed. Abundio still checks and
									downloads in the background.
								</div>
							</div>
							<button
								type="button"
								onClick={() => {
									setSkippedVersion(null);
									setSnoozedUntil(null);
								}}
								className="rounded-md transition-colors flex-shrink-0"
								style={{
									fontSize: 12,
									padding: "7px 12px",
									color: "var(--fg-primary)",
									backgroundColor: "var(--bg-tertiary)",
									border: "1px solid var(--border)",
								}}
							>
								Resume update prompts
							</button>
						</div>
					</div>
				)}

				<div
					style={{
						fontSize: 11,
						color: "var(--fg-secondary)",
						lineHeight: 1.5,
						marginTop: "auto",
						paddingTop: 4,
					}}
				>
					© 2026 Emil Müller and contributors · MIT OR Apache-2.0
				</div>
			</div>
			{confirmRestart && (
				<ConfirmDialog
					title="Restart to install update?"
					message="Restarting will close all windows and terminate any running terminals and agents. Unsaved work in editors will prompt to save."
					confirmLabel="Restart now"
					confirmVariant="danger"
					onConfirm={() => {
						setConfirmRestart(false);
						installNow();
					}}
					onCancel={() => setConfirmRestart(false)}
				/>
			)}
		</>
	);
}
