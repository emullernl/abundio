import { AlertTriangle, Check, X } from "lucide-react";
import type { HostCheck } from "../../lib/ipc";

/**
 * A Host's checklist (docs/plans/remote-hosts.md phase 8, "Host setup"):
 * one line per thing the app needs there, a ✓ or what fixes it.
 */
export function HostChecklist({ check }: { check: HostCheck }) {
	return (
		<div className="flex flex-col gap-1.5" role="list">
			{check.items.map((item) => (
				<div key={item.id} role="listitem" className="flex items-start gap-2">
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
					</div>
				</div>
			))}
		</div>
	);
}
