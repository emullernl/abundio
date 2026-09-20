/**
 * A select box built from our own elements, replacing the native `<select>`.
 *
 * ## Why not a native select
 *
 * A `<select>` is the one widget in this app that does not take our colours.
 * Without `appearance: none` the platform draws it — on Linux that is the GTK
 * theme, which ignores `background-color` and imposes its own text colour,
 * producing the pale-on-pale dropdown reported in the Settings window. macOS
 * blends closely enough that it was never noticed, which is exactly the kind of
 * difference that only surfaces on someone else's machine.
 *
 * `appearance: none` fixes the *closed* control, but the open popup is an
 * OS-level menu that CSS cannot reach: its frame, padding and highlight stay
 * the platform's whatever we do to `option`. Since the list is most of what the
 * user looks at, the control is rebuilt instead.
 *
 * ## The list is portalled
 *
 * Deliberately, and not for stacking: two of the three call sites sit inside an
 * ancestor with `overflow: hidden` (the Settings row card) or `overflow-y:
 * auto` (the parameter dialog's body), either of which would clip or scroll the
 * list away. A fixed-position portal escapes both. It closes on scroll and
 * resize rather than tracking them, so it can never be left floating away from
 * the control it belongs to.
 *
 * Escape closes the list and not the dialog around it, because `useEscapeKey`
 * dispatches to the topmost overlay and the list mounts last.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { Check, ChevronDown } from "../Icons";

export interface SelectOption {
	value: string;
	label: string;
}

interface SelectProps {
	value: string;
	options: SelectOption[];
	onChange: (value: string) => void;
	/** Applied to the closed control, so call sites keep using the shared field
	 *  styles they already pass to every other input. */
	style?: React.CSSProperties;
	className?: string;
	width?: number | string;
	placeholder?: string;
	"aria-label"?: string;
}

/** Room for the chevron. */
const CHEVRON_GUTTER = 26;
/** Roughly eight rows before the list scrolls; the agent list is the long one. */
const MAX_LIST_HEIGHT = 264;
const ROW_HEIGHT = 30;

export function Select({
	value,
	options,
	onChange,
	style,
	className,
	width = "auto",
	placeholder = "Choose…",
	"aria-label": ariaLabel,
}: SelectProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [rect, setRect] = useState<DOMRect | null>(null);
	const selectedIndex = options.findIndex((o) => o.value === value);
	// Starts on the current value so Enter-then-Enter is a no-op rather than a
	// silent change to whatever happened to be first.
	const [active, setActive] = useState(Math.max(0, selectedIndex));

	const selected = options[selectedIndex];

	function openList() {
		const el = triggerRef.current;
		if (!el) return;
		setRect(el.getBoundingClientRect());
		setActive(Math.max(0, selectedIndex));
		setOpen(true);
	}

	function close(refocus = true) {
		setOpen(false);
		if (refocus) triggerRef.current?.focus();
	}

	function commit(index: number) {
		const option = options[index];
		if (option) onChange(option.value);
		close();
	}

	useEscapeKey(() => {
		if (open) close();
	});

	// Dismiss on anything that would move the control out from under the list.
	// Closing beats re-measuring: a list that follows a scrolling pane is more
	// surprising than one that goes away.
	useEffect(() => {
		if (!open) return;
		// `setOpen` directly rather than `close`: this path never refocuses (the
		// user is scrolling or clicking elsewhere), and it keeps the effect from
		// depending on a function identity that changes every render.
		const dismiss = () => setOpen(false);
		window.addEventListener("resize", dismiss);
		window.addEventListener("scroll", dismiss, true);
		const onPointerDown = (e: MouseEvent) => {
			const target = e.target as Node;
			if (triggerRef.current?.contains(target)) return;
			if (listRef.current?.contains(target)) return;
			setOpen(false);
		};
		document.addEventListener("mousedown", onPointerDown, true);
		return () => {
			window.removeEventListener("resize", dismiss);
			window.removeEventListener("scroll", dismiss, true);
			document.removeEventListener("mousedown", onPointerDown, true);
		};
	}, [open]);

	// The list takes focus when it opens, so the arrow keys reach it without the
	// caller having to manage a roving tabindex.
	useLayoutEffect(() => {
		if (open) listRef.current?.focus();
	}, [open]);

	// Keep the highlighted row in view when arrowing through a scrolled list.
	useLayoutEffect(() => {
		if (!open) return;
		const row = listRef.current?.querySelector(`[data-index="${active}"]`);
		// Optional call, not just optional chaining: keeping a row in view is a
		// nicety, and an environment without `scrollIntoView` (jsdom, and older
		// webviews for the options object) must not take the dropdown down with it.
		row?.scrollIntoView?.({ block: "nearest" });
	}, [open, active]);

	function onTriggerKeyDown(e: React.KeyboardEvent) {
		if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") {
			e.preventDefault();
			openList();
		}
	}

	function onListKeyDown(e: React.KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((i) => Math.min(i + 1, options.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((i) => Math.max(i - 1, 0));
		} else if (e.key === "Home") {
			e.preventDefault();
			setActive(0);
		} else if (e.key === "End") {
			e.preventDefault();
			setActive(options.length - 1);
		} else if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			commit(active);
		} else if (e.key === "Tab") {
			// Tab commits nothing and lets focus move on, as a native select does.
			close(false);
		}
	}

	// Below when it fits, above when it does not — and clamped to the viewport
	// either way, because a trigger scrolled half out of view would otherwise
	// place the list off-screen entirely.
	const viewportH = typeof window === "undefined" ? 0 : window.innerHeight;
	const below = rect ? viewportH - rect.bottom : 0;
	const wanted = Math.min(MAX_LIST_HEIGHT, options.length * ROW_HEIGHT + 8);
	const dropUp = rect !== null && below < wanted + 8 && rect.top > below;
	const GAP = 4;
	const listTop = rect
		? dropUp
			? Math.max(GAP, rect.top - wanted - GAP)
			: Math.min(rect.bottom + GAP, Math.max(GAP, viewportH - wanted - GAP))
		: 0;

	return (
		<span
			className="relative inline-flex items-center"
			style={{ width, color: "var(--fg-secondary)" }}
		>
			<button
				ref={triggerRef}
				type="button"
				className={className}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={ariaLabel}
				style={{
					...style,
					width: "100%",
					paddingRight: CHEVRON_GUTTER,
					textAlign: "left",
					color: selected ? "var(--fg-primary)" : "var(--fg-secondary)",
					cursor: "pointer",
					// A long label must not push the control wider than its column.
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap",
				}}
				onClick={() => (open ? close() : openList())}
				onKeyDown={onTriggerKeyDown}
			>
				{selected ? selected.label : placeholder}
			</button>

			<span
				aria-hidden="true"
				className="absolute pointer-events-none flex items-center"
				style={{ right: 8, lineHeight: 0 }}
			>
				<ChevronDown />
			</span>

			{open &&
				rect &&
				createPortal(
					<div
						ref={listRef}
						role="listbox"
						tabIndex={0}
						aria-activedescendant={`select-option-${active}`}
						className="fixed rounded-lg overflow-y-auto"
						style={{
							left: Math.max(
								GAP,
								Math.min(
									rect.left,
									window.innerWidth - Math.max(rect.width, 160) - GAP,
								),
							),
							width: Math.max(rect.width, 160),
							top: listTop,
							maxHeight: Math.min(MAX_LIST_HEIGHT, viewportH - 2 * GAP),
							padding: 4,
							zIndex: 400,
							backgroundColor: "var(--bg-secondary)",
							border: "1px solid var(--border)",
							boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
							outline: "none",
						}}
						onKeyDown={onListKeyDown}
					>
						{options.map((option, i) => {
							const isSelected = option.value === value;
							const isActive = i === active;
							return (
								<button
									key={option.value}
									id={`select-option-${i}`}
									data-index={i}
									type="button"
									role="option"
									aria-selected={isSelected}
									className="w-full flex items-center gap-2 rounded-md text-left"
									style={{
										padding: "0 8px",
										height: ROW_HEIGHT - 2,
										fontSize: 12,
										color: isActive ? "var(--bg-primary)" : "var(--fg-primary)",
										backgroundColor: isActive ? "var(--accent)" : "transparent",
									}}
									onMouseEnter={() => setActive(i)}
									onClick={() => commit(i)}
								>
									<span
										className="shrink-0 flex items-center"
										style={{ width: 12, lineHeight: 0 }}
									>
										{isSelected && <Check />}
									</span>
									<span className="truncate">{option.label}</span>
								</button>
							);
						})}
					</div>,
					document.body,
				)}
		</span>
	);
}
