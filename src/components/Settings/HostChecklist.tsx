import { AlertTriangle, Check, Info, X } from "lucide-react";
import { useState } from "react";
import { problemItems } from "../../lib/hostSetup";
import type { HostCheck, HostCheckItem } from "../../lib/ipc";
import { secondaryButtonClass } from "../PromptActions/fieldStyles";

/** The fixes this build can carry out. */
const ACTION_LABELS: Partial<
	Record<NonNullable<HostCheckItem["action"]>, string>
> = {
	install: "Install",
	update: "Update",
	start: "Start",
	service: "Set up as a service",
	unservice: "Remove service",
};

/**
 * A Host's checklist (docs/plans/remote-hosts.md phase 8, "Host setup"):
 * one line per thing the app needs there, a ✓ or what fixes it.
 */
export function HostChecklist({
	check,
	busy,
	onAction,
}: {
	check: HostCheck;
	/** What is being done now ("Uploading the server…"), if anything: the
	 *  row's status line says it; the buttons only wait. */
	busy: string | null;
	onAction: (action: NonNullable<HostCheckItem["action"]>) => void;
}) {
	// Only what needs something, unless asked: a set-up Host is one line, its
	// status, and the rest is a click away.
	const [all, setAll] = useState(false);
	const problems = problemItems(check.items);
	const shown = all ? check.items : problems;
	return (
		<div className="flex flex-col" style={{ gap: 6 }}>
			{shown.length > 0 && (
				<ul className="flex flex-col" style={{ listStyle: "none", gap: 8 }}>
					{shown.map((item) => (
						<CheckLine
							key={item.id}
							item={item}
							busy={busy !== null}
							onAction={onAction}
						/>
					))}
				</ul>
			)}
			<button
				type="button"
				className="self-start rounded hover:underline"
				style={{ fontSize: 11, color: "var(--fg-secondary)" }}
				onClick={() => setAll((a) => !a)}
			>
				{all
					? problems.length > 0
						? "Show only what needs attention"
						: "Hide the checks"
					: `Show all ${check.items.length} checks`}
			</button>
		</div>
	);
}

function CheckLine({
	item,
	busy,
	onAction,
}: {
	item: HostCheckItem;
	busy: boolean;
	onAction: (action: NonNullable<HostCheckItem["action"]>) => void;
}) {
	return (
		<li className="flex items-start gap-2">
			<span style={{ flexShrink: 0, marginTop: 2 }}>
				{item.state === "ok" ? (
					<Check size={13} style={{ color: "var(--success, #3fb950)" }} />
				) : item.state === "info" ? (
					<Info size={13} style={{ color: "var(--fg-secondary)" }} />
				) : item.state === "warn" ? (
					<AlertTriangle
						size={13}
						style={{ color: "var(--warning, #d29922)" }}
					/>
				) : (
					<X size={13} style={{ color: "var(--error, #f85149)" }} />
				)}
			</span>
			<div className="flex flex-col min-w-0" style={{ gap: 2 }}>
				<span style={{ fontSize: 12, color: "var(--fg-primary)" }}>
					{item.label}
				</span>
				{item.fix && (
					<span
						style={{
							fontSize: 11,
							lineHeight: 1.45,
							color: "var(--fg-secondary)",
							userSelect: "text",
						}}
					>
						{item.fix}
					</span>
				)}
				{item.action && ACTION_LABELS[item.action] && (
					<div style={{ marginTop: 4 }}>
						<button
							type="button"
							className={`${secondaryButtonClass} rounded-md`}
							style={{ fontSize: 12, height: 26, padding: "0 10px" }}
							disabled={busy}
							onClick={() => item.action && onAction(item.action)}
						>
							{ACTION_LABELS[item.action]}
						</button>
					</div>
				)}
			</div>
		</li>
	);
}
