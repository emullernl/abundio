import { open } from "@tauri-apps/plugin-shell";
import type { PullRequest } from "../../lib/types";
import { ExternalLink } from "../Icons";

interface Props {
	pr: PullRequest;
	showStatus?: boolean;
}

function ReviewBadge({ decision }: { decision: string }) {
	if (decision === "APPROVED") {
		return (
			<span
				className="flex items-center gap-1 flex-shrink-0"
				style={{ fontSize: 10, color: "var(--success)" }}
			>
				<svg
					aria-hidden="true"
					width="11"
					height="11"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M20 6L9 17l-5-5" />
				</svg>
				Approved
			</span>
		);
	}
	if (decision === "CHANGES_REQUESTED") {
		return (
			<span
				className="flex items-center gap-1 flex-shrink-0"
				style={{ fontSize: 10, color: "var(--warning)" }}
			>
				<svg
					aria-hidden="true"
					width="11"
					height="11"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M12 9v4M12 17h.01" />
				</svg>
				Changes
			</span>
		);
	}
	return null;
}

function CiDot({ status }: { status: string }) {
	const color =
		status === "SUCCESS"
			? "var(--success)"
			: status === "FAILURE"
				? "var(--error)"
				: status === "PENDING"
					? "var(--warning)"
					: null;
	if (!color) return null;
	return (
		<span
			className="flex-shrink-0 rounded-full"
			title={`CI: ${status.toLowerCase()}`}
			style={{
				width: 6,
				height: 6,
				backgroundColor: color,
			}}
		/>
	);
}

export function PullRequestItem({ pr, showStatus }: Props) {
	const hasStatus =
		showStatus && (pr.reviewDecision || pr.statusCheckRollup || pr.isDraft);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: hover effect container
		<div
			className="w-full text-left transition-colors group"
			style={{
				padding: "6px 12px",
				backgroundColor: "transparent",
				outline: "none",
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.backgroundColor =
					"color-mix(in srgb, var(--bg-tertiary) 60%, transparent)";
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.backgroundColor = "transparent";
			}}
		>
			{/* Row 1: number + title + open link */}
			<div className="flex items-center gap-1.5 min-w-0">
				<span
					className="flex-shrink-0"
					style={{
						fontSize: 11,
						color: "var(--accent)",
						fontFamily: "var(--font-mono)",
					}}
				>
					#{pr.number}
				</span>
				<span
					className="truncate flex-1 min-w-0"
					style={{ fontSize: 11, color: "var(--fg-primary)" }}
				>
					{pr.title}
				</span>
				{pr.url && (
					<button
						type="button"
						title="Open in browser"
						onClick={() => open(pr.url)}
						className="flex items-center justify-center rounded transition-opacity opacity-0 group-hover:opacity-70 hover:!opacity-100 flex-shrink-0"
						style={{
							width: 18,
							height: 18,
							color: "var(--fg-secondary)",
							background: "none",
							border: "none",
							cursor: "pointer",
							padding: 0,
						}}
					>
						<ExternalLink size={12} />
					</button>
				)}
			</div>

			{/* Row 2: author + repo + status */}
			<div
				className="flex items-center gap-1.5 mt-0.5"
				style={{ fontSize: 10, color: "var(--fg-secondary)" }}
			>
				{pr.author && <span>@{pr.author}</span>}
				{pr.author && pr.repository && <span>·</span>}
				{pr.repository && (
					<span
						className="truncate"
						style={{ fontFamily: "var(--font-mono)", maxWidth: 140 }}
					>
						{pr.repository}
					</span>
				)}
				{hasStatus && (
					<>
						<span style={{ opacity: 0.4 }}>·</span>
						{pr.isDraft && (
							<span
								style={{
									fontSize: 9,
									color: "var(--fg-secondary)",
									opacity: 0.7,
									fontFamily: "var(--font-mono)",
									letterSpacing: "0.03em",
								}}
							>
								Draft
							</span>
						)}
						<ReviewBadge decision={pr.reviewDecision} />
						<CiDot status={pr.statusCheckRollup} />
					</>
				)}
			</div>
		</div>
	);
}
