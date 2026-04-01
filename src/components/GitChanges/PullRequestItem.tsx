import { open } from "@tauri-apps/plugin-shell";
import type { PullRequest } from "../../lib/types";
import { ExternalLink } from "../Icons";

interface Props {
	pr: PullRequest;
}

export function PullRequestItem({ pr }: Props) {
	return (
		<div
			className="w-full text-left transition-colors group"
			style={{
				padding: "6px 12px",
				backgroundColor: "transparent",
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.backgroundColor = "color-mix(in srgb, var(--bg-tertiary) 60%, transparent)";
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.backgroundColor = "transparent";
			}}
		>
			{/* Row 1: number + title + open link */}
			<div className="flex items-center gap-1.5 min-w-0">
				<span
					className="flex-shrink-0"
					style={{ fontSize: 11, color: "var(--accent)", fontFamily: "var(--font-mono)" }}
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

			{/* Row 2: author + repo */}
			<div className="flex items-center gap-1.5 mt-0.5" style={{ fontSize: 10, color: "var(--fg-secondary)" }}>
				{pr.author && (
					<span>@{pr.author}</span>
				)}
				{pr.author && pr.repository && <span>·</span>}
				{pr.repository && (
					<span className="truncate" style={{ fontFamily: "var(--font-mono)", maxWidth: 140 }}>
						{pr.repository}
					</span>
				)}
			</div>
		</div>
	);
}
