import { useEffect, useRef } from "react";

export interface ContextMenuAction {
	label: string;
	shortcut?: string;
	separator?: false;
	disabled?: boolean;
	onClick: () => void;
}

export interface ContextMenuSeparator {
	separator: true;
}

export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator;

interface Props {
	x: number;
	y: number;
	items: ContextMenuItem[];
	onClose: () => void;
}

export function PaneContextMenu({ x, y, items, onClose }: Props) {
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		function handleClickOutside(e: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				onClose();
			}
		}
		function handleEscape(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}

		document.addEventListener("mousedown", handleClickOutside, true);
		document.addEventListener("keydown", handleEscape, true);
		return () => {
			document.removeEventListener("mousedown", handleClickOutside, true);
			document.removeEventListener("keydown", handleEscape, true);
		};
	}, [onClose]);

	// Adjust position so menu stays within viewport
	useEffect(() => {
		if (!menuRef.current) return;
		const rect = menuRef.current.getBoundingClientRect();
		if (rect.right > window.innerWidth) {
			menuRef.current.style.left = `${window.innerWidth - rect.width - 8}px`;
		}
		if (rect.bottom > window.innerHeight) {
			menuRef.current.style.top = `${window.innerHeight - rect.height - 8}px`;
		}
	}, []);

	return (
		<div
			ref={menuRef}
			className="fixed z-[100] rounded-xl shadow-2xl"
			style={{
				left: x,
				top: y,
				minWidth: 240,
				padding: "5px",
				backgroundColor: "var(--bg-secondary)",
				border: "1px solid var(--border)",
			}}
		>
			{items.map((item, i) => {
				if (item.separator) {
					return (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: separators have no unique identifier
							key={`sep-${i}`}
							style={{
								height: 1,
								backgroundColor: "var(--border)",
								margin: "4px 8px",
							}}
						/>
					);
				}

				return (
					<button
						key={item.label}
						type="button"
						disabled={item.disabled}
						onClick={() => {
							item.onClick();
							onClose();
						}}
						className="w-full text-left flex items-center justify-between rounded-md hover:bg-[var(--accent)] hover:text-[var(--bg-primary)] transition-colors disabled:opacity-40 disabled:cursor-default"
						style={{
							color: "var(--fg-primary)",
							fontSize: 14,
							padding: "7px 12px",
							gap: 20,
						}}
					>
						<span>{item.label}</span>
						{item.shortcut && (
							<span style={{ color: "var(--fg-secondary)", fontSize: 13 }}>
								{item.shortcut}
							</span>
						)}
					</button>
				);
			})}
		</div>
	);
}
