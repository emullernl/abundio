import { useEffect, useRef, useState } from "react";
import { shells as shellsIpc } from "../../lib/ipc";
import type { AvailableShell } from "../../lib/types";
import { useSettingsStore } from "../../stores/settingsStore";
import { Check } from "../Icons";

/* ─── Shell row ─── */
function ShellRow({
	name,
	path,
	isSelected,
	available,
	badge,
	onSelect,
}: {
	name: string;
	path: string;
	isSelected: boolean;
	available: boolean;
	badge?: string;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={available ? onSelect : undefined}
			className="w-full text-left rounded-lg flex items-center gap-3 transition-colors"
			style={{
				padding: "9px 10px",
				backgroundColor: isSelected
					? "color-mix(in srgb, var(--accent) 10%, transparent)"
					: "transparent",
				borderLeft: isSelected
					? "2px solid var(--accent)"
					: "2px solid transparent",
				opacity: available ? 1 : 0.4,
				cursor: available ? "pointer" : "default",
			}}
		>
			<div className="flex-1 min-w-0">
				<div
					className="truncate flex items-center gap-2"
					style={{
						fontSize: 13,
						color: "var(--fg-primary)",
						lineHeight: 1.3,
					}}
				>
					{name}
					{badge && (
						<span
							className="flex-shrink-0 rounded"
							style={{
								fontSize: 9,
								fontWeight: 600,
								color: "var(--fg-secondary)",
								letterSpacing: "0.05em",
								textTransform: "uppercase",
								padding: "1px 5px",
								border: "1px solid var(--border)",
								opacity: 0.6,
							}}
						>
							{badge}
						</span>
					)}
				</div>
				{path && (
					<div
						className="truncate"
						style={{
							fontSize: 11,
							color: isSelected ? "var(--accent)" : "var(--fg-secondary)",
							fontFamily: "var(--font-mono)",
							marginTop: 1,
							opacity: isSelected ? 1 : 0.7,
						}}
					>
						{path}
					</div>
				)}
			</div>
			{isSelected && (
				<div style={{ color: "var(--accent)", flexShrink: 0 }}>
					<Check size={14} />
				</div>
			)}
			{!available && (
				<span
					className="flex-shrink-0"
					style={{
						fontSize: 10,
						color: "var(--fg-secondary)",
						opacity: 0.7,
					}}
				>
					Not found
				</span>
			)}
		</button>
	);
}

/** The Default Shell list — System Default plus every shell Rust found. */
export function ShellPicker() {
	const shellPath = useSettingsStore((s) => s.shellPath);
	const setShellPath = useSettingsStore((s) => s.setShellPath);

	const [availableShells, setAvailableShells] = useState<AvailableShell[]>([]);
	const shellsLoaded = useRef(false);
	useEffect(() => {
		if (shellsLoaded.current) return;
		shellsIpc
			.listAvailable()
			.then((shells) => {
				setAvailableShells(shells);
				shellsLoaded.current = true;
			})
			.catch(() => {
				setAvailableShells([]);
			});
	}, []);

	return (
		<div className="overflow-y-auto flex flex-col flex-1 min-h-0 gap-0.5">
			<ShellRow
				name="System Default"
				path={availableShells.find((s) => s.isDefault)?.path ?? ""}
				isSelected={shellPath === null}
				available={true}
				badge="Default"
				onSelect={() => setShellPath(null)}
			/>
			{availableShells.map((shell) => (
				<ShellRow
					key={shell.path}
					name={shell.name}
					path={shell.path}
					isSelected={shellPath === shell.path}
					available={shell.available}
					onSelect={() => setShellPath(shell.path)}
				/>
			))}
		</div>
	);
}
