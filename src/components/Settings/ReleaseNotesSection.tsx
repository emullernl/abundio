import { open } from "@tauri-apps/plugin-shell";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import {
	type ReleaseNotesEntry,
	selectReleaseNotes,
} from "../../lib/releaseNotes";
import { useUpdateStore } from "../../stores/updateStore";
import { SectionLabel } from "./primitives";
import { ReleaseNotesMarkdown } from "./ReleaseNotesMarkdown";

/**
 * The "Release Notes" block of the Updates page. See ADR-0036.
 *
 * Sits **last**, below the settings controls, so adding an unbounded Markdown
 * body to this page does not push the toggles off screen. Which releases appear,
 * and under which heading, is decided entirely by `selectReleaseNotes` — this
 * component only draws the result.
 */

const RELEASES_URL = "https://github.com/emullernl/abundio/releases";

function openReleases() {
	open(RELEASES_URL).catch(() => {});
}

function LinkButton({
	children,
	onClick,
}: {
	children: React.ReactNode;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="text-left transition-colors"
			style={{
				fontSize: 12,
				color: "var(--accent)",
				background: "transparent",
				border: "none",
				padding: 0,
				cursor: "pointer",
			}}
		>
			{children}
		</button>
	);
}

function ReleaseRow({ entry }: { entry: ReleaseNotesEntry }) {
	const [expanded, setExpanded] = useState(entry.defaultExpanded);
	const { release, isCurrent } = entry;

	return (
		<div style={{ borderTop: "1px solid var(--border)" }}>
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
				className="w-full flex items-center gap-2 transition-colors"
				style={{
					padding: "9px 2px",
					background: "transparent",
					border: "none",
					cursor: "pointer",
					textAlign: "left",
				}}
			>
				<ChevronRight
					size={13}
					style={{
						color: "var(--fg-secondary)",
						flexShrink: 0,
						transform: expanded ? "rotate(90deg)" : "none",
						transition: "transform 120ms ease",
					}}
				/>
				<span
					className="font-mono"
					style={{ fontSize: 12, color: "var(--fg-primary)" }}
				>
					v{release.version}
				</span>
				{isCurrent && (
					<span style={{ fontSize: 11, color: "var(--fg-secondary)" }}>
						· you're running this
					</span>
				)}
				{release.publishedAt && (
					<span
						style={{
							fontSize: 11,
							color: "var(--fg-secondary)",
							marginLeft: "auto",
						}}
					>
						{new Date(release.publishedAt).toLocaleDateString()}
					</span>
				)}
			</button>
			{expanded && (
				<div style={{ padding: "0 2px 14px 21px" }}>
					{release.body ? (
						<ReleaseNotesMarkdown body={release.body} />
					) : (
						<div style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
							This release has no notes.
						</div>
					)}
				</div>
			)}
		</div>
	);
}

export function ReleaseNotesSection({
	currentVersion,
}: {
	currentVersion: string;
}) {
	const notes = useUpdateStore((s) => s.notes);
	const notesStatus = useUpdateStore((s) => s.notesStatus);
	const fetchNotes = useUpdateStore((s) => s.fetchNotes);
	const info = useUpdateStore((s) => s.info);

	// Fetched on mount rather than on expand: the section sits at the bottom of
	// a scrolling page, so a lazy fetch would mean clicking a triangle and then
	// waiting. With the hourly Rust-side cache, revisits cost nothing.
	//
	// Deliberately not gated on `currentVersion`: the list GitHub returns does
	// not depend on which version is running, so this starts in parallel with
	// `getVersion()` rather than after it.
	useEffect(() => {
		fetchNotes();
	}, [fetchNotes]);

	// Until `getVersion()` resolves there is nothing to anchor against, and an
	// anchoring rule fed an empty string would call every release "newer".
	if (!currentVersion) return null;

	if (notesStatus === "error") {
		return (
			<div>
				<SectionLabel>Release Notes</SectionLabel>
				{/* The update we are being offered still has its notes in memory from
				    the updater check, so they survive a failed list fetch. */}
				{info?.body ? (
					<>
						<div
							style={{
								fontSize: 12,
								color: "var(--fg-primary)",
								marginBottom: 8,
							}}
						>
							What's new in {info.version}
						</div>
						<ReleaseNotesMarkdown body={info.body} />
						<div
							style={{
								fontSize: 12,
								color: "var(--fg-secondary)",
								marginTop: 10,
							}}
						>
							Couldn't load older release notes.
						</div>
					</>
				) : (
					<div
						style={{
							fontSize: 12,
							color: "var(--fg-secondary)",
							marginBottom: 8,
						}}
					>
						Couldn't load release notes.
					</div>
				)}
				<div className="flex items-center gap-4" style={{ marginTop: 6 }}>
					<LinkButton onClick={openReleases}>View on GitHub ↗</LinkButton>
					<LinkButton onClick={() => fetchNotes({ refresh: true })}>
						Retry
					</LinkButton>
				</div>
			</div>
		);
	}

	if (notes == null) {
		return (
			<div>
				<SectionLabel>Release Notes</SectionLabel>
				<div style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
					Loading…
				</div>
			</div>
		);
	}

	const view = selectReleaseNotes(currentVersion, notes);

	return (
		<div>
			<SectionLabel>{view.heading}</SectionLabel>
			{view.missingCurrentVersion && (
				<div
					style={{
						fontSize: 12,
						color: "var(--fg-secondary)",
						marginBottom: 10,
						lineHeight: 1.5,
					}}
				>
					No published release notes for v{view.missingCurrentVersion}.
				</div>
			)}
			{view.entries.map((entry) => (
				<ReleaseRow key={entry.release.version} entry={entry} />
			))}
			<div style={{ marginTop: 10 }}>
				<LinkButton onClick={openReleases}>
					{view.showOlderLink
						? "Older releases on GitHub ↗"
						: "View all releases ↗"}
				</LinkButton>
			</div>
		</div>
	);
}
