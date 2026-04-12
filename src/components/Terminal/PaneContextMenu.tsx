import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface ContextMenuAction {
	label: string;
	shortcut?: string;
	separator?: false;
	disabled?: boolean;
	icon?: React.ReactNode;
	onClick?: () => void;
	submenu?: ContextMenuItem[];
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
			<MenuItems items={items} onClose={onClose} />
		</div>
	);
}

function MenuItems({
	items,
	onClose,
}: {
	items: ContextMenuItem[];
	onClose: () => void;
}) {
	const [openSubmenuKey, setOpenSubmenuKey] = useState<string | null>(null);
	const closeTimerRef = useRef<number | null>(null);

	const clearCloseTimer = () => {
		if (closeTimerRef.current !== null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	};

	const scheduleClose = () => {
		clearCloseTimer();
		closeTimerRef.current = window.setTimeout(() => {
			setOpenSubmenuKey(null);
		}, 150);
	};

	return (
		<>
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

				const hasSubmenu = !!item.submenu && item.submenu.length > 0;
				const isOpen = openSubmenuKey === item.label;
				const rowRef = (el: HTMLButtonElement | null) => {
					if (el && isOpen) {
						// Force re-render not needed — submenu position computed from live rect
					}
				};

				return (
					// biome-ignore lint/a11y/noStaticElementInteractions: hover wrapper for submenu — button inside is keyboard-accessible
					<div
						key={item.label}
						style={{ position: "relative" }}
						onMouseEnter={() => {
							if (!item.disabled && hasSubmenu) {
								clearCloseTimer();
								setOpenSubmenuKey(item.label);
							} else {
								scheduleClose();
							}
						}}
						onMouseLeave={() => {
							if (hasSubmenu) scheduleClose();
						}}
					>
						<button
							ref={rowRef}
							type="button"
							disabled={item.disabled}
							onClick={() => {
								if (item.disabled) return;
								if (hasSubmenu) return;
								item.onClick?.();
								onClose();
							}}
							className="w-full text-left flex items-center justify-between rounded-md hover:bg-[var(--accent)] hover:text-[var(--bg-primary)] transition-colors disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-[var(--fg-primary)]"
							style={{
								color: "var(--fg-primary)",
								fontSize: 14,
								padding: "7px 12px",
								gap: 20,
								backgroundColor:
									isOpen && !item.disabled ? "var(--accent)" : undefined,
							}}
						>
							<span className="flex items-center" style={{ gap: 10 }}>
								{item.icon && (
									<span
										style={{
											display: "inline-flex",
											width: 16,
											height: 16,
											alignItems: "center",
											justifyContent: "center",
										}}
									>
										{item.icon}
									</span>
								)}
								<span>{item.label}</span>
							</span>
							{hasSubmenu ? (
								<ChevronRight size={14} />
							) : item.shortcut ? (
								<span style={{ color: "var(--fg-secondary)", fontSize: 13 }}>
									{item.shortcut}
								</span>
							) : null}
						</button>

						{isOpen && hasSubmenu && !item.disabled && (
							// biome-ignore lint/a11y/noStaticElementInteractions: submenu panel — contained buttons are keyboard-accessible
							<div
								className="rounded-xl shadow-2xl"
								style={{
									position: "absolute",
									top: -5,
									left: "100%",
									marginLeft: 4,
									minWidth: 220,
									padding: 5,
									backgroundColor: "var(--bg-secondary)",
									border: "1px solid var(--border)",
									zIndex: 1,
								}}
								onMouseEnter={clearCloseTimer}
								onMouseLeave={scheduleClose}
							>
								<MenuItems items={item.submenu ?? []} onClose={onClose} />
							</div>
						)}
					</div>
				);
			})}
		</>
	);
}
