import { Info } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { hostFootprint } from "../../lib/hostFootprint";
import type { HostCheck } from "../../lib/ipc";
import { secondaryButtonClass } from "../PromptActions/fieldStyles";

const WIDTH = 380;

/**
 * The ⓘ beside a Host's name: what Abundio put on that Host and what it
 * does there, from its last Check (or what Install would do), so nothing
 * about the setup is hidden. Opens on click; Escape or a click outside
 * closes it.
 */
export function HostFootprintButton({
	hostName,
	check,
	onCheck,
}: {
	hostName: string;
	check: HostCheck | null;
	onCheck: () => void;
}) {
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	return (
		<>
			<button
				ref={button}
				type="button"
				aria-label={`What Abundio sets up on ${hostName}`}
				aria-expanded={open}
				className="rounded hover:bg-[var(--bg-tertiary)] flex items-center justify-center"
				style={{ width: 20, height: 20, color: "var(--fg-secondary)" }}
				onClick={() => setOpen((o) => !o)}
			>
				<Info size={13} />
			</button>
			{open && (
				<Popover
					anchor={button.current}
					hostName={hostName}
					check={check}
					onCheck={() => {
						setOpen(false);
						onCheck();
					}}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}

function Popover({
	anchor,
	hostName,
	check,
	onCheck,
	onClose,
}: {
	anchor: HTMLElement | null;
	hostName: string;
	check: HostCheck | null;
	onCheck: () => void;
	onClose: () => void;
}) {
	const card = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	useEscapeKey(onClose);

	// Below the ⓘ, kept inside the window.
	useLayoutEffect(() => {
		if (!anchor) return;
		const r = anchor.getBoundingClientRect();
		const left = Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8));
		setPos({ top: r.bottom + 6, left });
	}, [anchor]);

	useEffect(() => {
		const down = (e: MouseEvent) => {
			const t = e.target as Node;
			if (card.current?.contains(t) || anchor?.contains(t)) return;
			onClose();
		};
		document.addEventListener("mousedown", down);
		return () => document.removeEventListener("mousedown", down);
	}, [anchor, onClose]);

	const f = hostFootprint(check);
	return createPortal(
		<div
			ref={card}
			role="dialog"
			aria-label={`What Abundio sets up on ${hostName}`}
			className="rounded-lg flex flex-col"
			style={{
				position: "fixed",
				top: pos?.top ?? -9999,
				left: pos?.left ?? -9999,
				width: WIDTH,
				maxHeight: "min(70vh, 520px)",
				overflowY: "auto",
				zIndex: 240,
				padding: "14px 16px",
				gap: 12,
				fontSize: 12,
				lineHeight: 1.5,
				color: "var(--fg-secondary)",
				backgroundColor: "var(--bg-secondary)",
				border: "1px solid var(--border)",
				boxShadow: "0 16px 40px rgba(0,0,0,0.35)",
			}}
			onKeyDown={(e) => e.stopPropagation()}
		>
			<div
				style={{ color: "var(--fg-primary)", fontSize: 13, fontWeight: 600 }}
			>
				What Abundio sets up on {hostName}
			</div>
			{f.unknown && (
				<div className="flex items-center gap-2">
					<span>Not checked yet, so this is what Install would do.</span>
					<button
						type="button"
						className={`${secondaryButtonClass} rounded-md`}
						style={{
							fontSize: 12,
							height: 24,
							padding: "0 10px",
							flexShrink: 0,
						}}
						onClick={onCheck}
					>
						Check
					</button>
				</div>
			)}
			{f.sections.map((s) => (
				<section key={s.title} className="flex flex-col" style={{ gap: 4 }}>
					<div style={{ color: "var(--fg-primary)", fontWeight: 500 }}>
						{s.title}
					</div>
					{s.lines.map((l) => (
						<div key={l.text} className="flex flex-col" style={{ gap: 2 }}>
							<span>{l.text}</span>
							{l.path && (
								<code
									style={{
										alignSelf: "flex-start",
										fontSize: 11,
										padding: "1px 6px",
										borderRadius: 4,
										userSelect: "all",
										color: "var(--fg-primary)",
										backgroundColor: "var(--bg-tertiary)",
										fontFamily: "var(--font-mono)",
										wordBreak: "break-all",
									}}
								>
									{l.path}
								</code>
							)}
						</div>
					))}
				</section>
			))}
		</div>,
		document.body,
	);
}
