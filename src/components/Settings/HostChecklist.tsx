import { AlertTriangle, Check, X } from "lucide-react";
import { useState } from "react";
import { writeClipboardText } from "../../lib/clipboard";
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
	/** What is being done now ("Uploading the server…"), if anything. */
	busy: string | null;
	onAction: (action: NonNullable<HostCheckItem["action"]>) => void;
}) {
	return (
		<ul className="flex flex-col gap-1.5" style={{ listStyle: "none" }}>
			{check.items.map((item) => (
				<li key={item.id} className="flex items-start gap-2">
					<span style={{ flexShrink: 0, marginTop: 1 }}>
						{item.state === "ok" ? (
							<Check size={13} style={{ color: "var(--success, #3fb950)" }} />
						) : item.state === "warn" ? (
							<AlertTriangle
								size={13}
								style={{ color: "var(--warning, #d29922)" }}
							/>
						) : (
							<X size={13} style={{ color: "var(--error, #f85149)" }} />
						)}
					</span>
					<div className="flex flex-col min-w-0">
						<span style={{ fontSize: 12, color: "var(--fg-primary)" }}>
							{item.label}
						</span>
						{item.action && ACTION_LABELS[item.action] && (
							<div style={{ marginTop: 4 }}>
								<button
									type="button"
									className={`${secondaryButtonClass} rounded-md`}
									style={{ fontSize: 12, height: 26, padding: "0 10px" }}
									disabled={busy !== null}
									onClick={() => item.action && onAction(item.action)}
								>
									{busy ?? ACTION_LABELS[item.action]}
								</button>
							</div>
						)}
						{item.fix && (
							<span
								style={{
									fontSize: 11,
									color: "var(--fg-secondary)",
									userSelect: "text",
								}}
							>
								{item.fix}
							</span>
						)}
						{item.steps && <CopySteps text={item.steps} />}
					</div>
				</li>
			))}
		</ul>
	);
}

/** Commands for the user to run on the Host, to copy (phase 13: Abundio
 *  never runs them). */
function CopySteps({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex flex-col" style={{ gap: 4, marginTop: 4 }}>
			<pre
				style={{
					margin: 0,
					padding: "8px 10px",
					maxHeight: 160,
					overflow: "auto",
					fontSize: 10.5,
					fontFamily: "var(--font-mono)",
					borderRadius: 6,
					border: "1px solid var(--border)",
					background: "var(--bg-primary)",
					color: "var(--fg-primary)",
					userSelect: "text",
					whiteSpace: "pre",
				}}
			>
				{text}
			</pre>
			<div>
				<button
					type="button"
					className={`${secondaryButtonClass} rounded-md`}
					style={{ fontSize: 11, height: 24, padding: "0 10px" }}
					onClick={() =>
						void writeClipboardText(text).then(
							() => setCopied(true),
							() => {},
						)
					}
				>
					{copied ? "Copied" : "Copy"}
				</button>
			</div>
		</div>
	);
}
