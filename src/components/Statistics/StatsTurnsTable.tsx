import { Download } from "lucide-react";
import { isDemoMode } from "../../lib/demo";
import { type AgentTurnRecord, fs } from "../../lib/ipc";
import { SectionTitle } from "./StatsActivityChart";
import { agentLabel, formatDuration, turnsToCsv } from "./statsCompute";

const MAX_ROWS = 60;
const GRID = "1.1fr 1.5fr 1fr 0.7fr 0.7fr 1.1fr";

function startedLabel(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Browser <a download> fallback. Works in the demo/web build; WKWebView in the
 *  packaged app ignores programmatic anchor downloads, so the native path below
 *  is used there instead. */
function downloadViaBlob(csv: string, filename: string) {
	const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

/** Save `turns` as CSV. In the packaged app this opens a native save dialog and
 *  writes the chosen file; in the demo/web build it triggers a browser
 *  download. */
async function exportTurnsCsv(turns: AgentTurnRecord[], filename: string) {
	const csv = turnsToCsv(turns);
	if (isDemoMode()) {
		downloadViaBlob(csv, filename);
		return;
	}
	const { save } = await import("@tauri-apps/plugin-dialog");
	const path = await save({
		defaultPath: filename,
		filters: [{ name: "CSV", extensions: ["csv"] }],
	});
	if (!path) return; // user cancelled the dialog
	await fs.writeFile(path, csv);
}

export function StatsTurnsTable({
	turns,
	profileName,
	rangeLabel,
}: {
	turns: AgentTurnRecord[];
	profileName?: string;
	rangeLabel?: string;
}) {
	const rows = turns.slice(0, MAX_ROWS);

	const onExport = () => {
		const parts = [
			"abundio-turns",
			profileName && slugify(profileName),
			rangeLabel && slugify(rangeLabel),
		].filter(Boolean);
		exportTurnsCsv(turns, `${parts.join("-")}.csv`).catch((err) => {
			console.error("Failed to export turns CSV", err);
		});
	};

	return (
		<section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 12,
				}}
			>
				<SectionTitle>Recent turns</SectionTitle>
				{turns.length > MAX_ROWS && (
					<span style={{ fontSize: 10.5, color: "var(--fg-secondary)" }}>
						showing {MAX_ROWS} of {turns.length.toLocaleString()}
					</span>
				)}
				<button
					type="button"
					onClick={onExport}
					disabled={turns.length === 0}
					title={`Export all ${turns.length.toLocaleString()} turns in this range to CSV`}
					style={{
						display: "flex",
						alignItems: "center",
						gap: 6,
						marginLeft: "auto",
						fontSize: 11,
						padding: "4px 10px",
						borderRadius: 6,
						border: "1px solid var(--border)",
						backgroundColor: "var(--bg-secondary)",
						color: "var(--fg-secondary)",
						cursor: turns.length === 0 ? "default" : "pointer",
						opacity: turns.length === 0 ? 0.4 : 1,
					}}
				>
					<Download size={13} />
					Export CSV
				</button>
			</div>
			<div
				style={{
					border: "1px solid var(--border)",
					borderRadius: 8,
					backgroundColor: "var(--bg-secondary)",
					overflow: "hidden",
				}}
			>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: GRID,
						gap: 10,
						padding: "9px 14px",
						fontSize: 8.5,
						letterSpacing: "0.1em",
						textTransform: "uppercase",
						color: "var(--fg-secondary)",
						borderBottom: "1px solid var(--border)",
					}}
				>
					<span>Agent</span>
					<span>Workspace</span>
					<span>Started</span>
					<span>Wall</span>
					<span>Working</span>
					<span style={{ textAlign: "right" }}>Lines</span>
				</div>
				{rows.length === 0 ? (
					<div
						style={{
							padding: "14px",
							color: "var(--fg-secondary)",
							fontSize: 12,
						}}
					>
						No turns in this range
					</div>
				) : (
					rows.map((t) => (
						<div
							key={t.id}
							style={{
								display: "grid",
								gridTemplateColumns: GRID,
								gap: 10,
								padding: "8px 14px",
								fontSize: 11.5,
								borderTop:
									"1px solid color-mix(in srgb, var(--border) 55%, transparent)",
								fontVariantNumeric: "tabular-nums",
								alignItems: "center",
							}}
						>
							<span style={{ color: "var(--fg-primary)" }}>
								{agentLabel(t.agentId)}
							</span>
							<span
								title={t.workspacePath}
								style={{
									color: "var(--fg-secondary)",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
								}}
							>
								{t.workspaceName || "—"}
							</span>
							<span
								style={{
									color: "var(--fg-secondary)",
									fontFamily: "var(--font-mono)",
									fontSize: 11,
								}}
							>
								{startedLabel(t.startedAt)}
							</span>
							<span
								style={{
									color: "var(--fg-secondary)",
									fontFamily: "var(--font-mono)",
									fontSize: 11,
								}}
							>
								{formatDuration(t.durationMs ?? 0)}
							</span>
							<span
								style={{
									color: "var(--fg-primary)",
									fontFamily: "var(--font-mono)",
									fontSize: 11,
								}}
							>
								{formatDuration(t.workingMs ?? 0)}
							</span>
							<span
								style={{
									textAlign: "right",
									fontFamily: "var(--font-mono)",
									fontSize: 11,
								}}
							>
								{t.linesAdded === null || t.linesDeleted === null ? (
									<span style={{ color: "var(--fg-secondary)", opacity: 0.7 }}>
										unmeasured
									</span>
								) : (
									<>
										<span style={{ color: "rgb(124 196 144)" }}>
											+{t.linesAdded}
										</span>{" "}
										<span style={{ color: "rgb(244 113 116)" }}>
											−{t.linesDeleted}
										</span>
									</>
								)}
							</span>
						</div>
					))
				)}
			</div>
		</section>
	);
}
