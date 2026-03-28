import { useEffect, useRef } from "react";
import { pty } from "../../lib/ipc";
import {
	getTerminal,
	createTerminal,
	destroyTerminal,
} from "../../lib/terminalManager";
import { useSettingsStore } from "../../stores/settingsStore";
import { getTheme } from "../../lib/themes";
import { getTarget, onTargetChange } from "../../lib/portalRegistry";
import "@xterm/xterm/css/xterm.css";

interface Props {
	paneId: string;
	ptyId: string;
	cwd: string;
}

export function TerminalInstance({ paneId, ptyId, cwd }: Props) {
	const stableRef = useRef<HTMLDivElement>(null);
	const resizeObserverRef = useRef<ResizeObserver | null>(null);
	const resizeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

	useEffect(() => {
		if (!stableRef.current) return;

		let cancelled = false;

		const init = async () => {
			if (cancelled || !stableRef.current) return;

			// Only create if not already existing
			if (!getTerminal(paneId)) {
				const { fontFamily, fontSize, theme: themeName } = useSettingsStore.getState();
				const currentTheme = getTheme(themeName);
				await createTerminal(paneId, ptyId, cwd, stableRef.current, {
					fontSize,
					fontFamily,
					theme: currentTheme.terminal,
				});
			}

			if (cancelled) return;

			// Project into current target if one is already registered
			const target = getTarget(paneId);
			if (target) projectInto(paneId, target);

			// Listen for future target changes (split/close causes placeholder remount)
			const unsubscribe = onTargetChange(paneId, (el) => {
				if (cancelled) return;
				if (el) {
					projectInto(paneId, el);
				} else {
					retract(paneId, stableRef.current);
				}
			});

			return unsubscribe;
		};

		let unsubscribe: (() => void) | undefined;
		init().then((unsub) => {
			if (cancelled && unsub) {
				unsub();
			} else {
				unsubscribe = unsub;
			}
		});

		return () => {
			cancelled = true;
			unsubscribe?.();
			cleanupResizeObserver();
			destroyTerminal(paneId);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [paneId]);

	function projectInto(id: string, target: HTMLDivElement) {
		const managed = getTerminal(id);
		if (!managed) return;

		const termEl = managed.term.element;
		if (termEl && termEl.parentElement !== target) {
			target.appendChild(termEl);
		}

		managed.fitAddon.fit();
		if (managed.ptyId) {
			pty.resize(managed.ptyId, managed.term.cols, managed.term.rows).catch(() => {});
		}

		// Observe the target for resize
		cleanupResizeObserver();
		resizeObserverRef.current = new ResizeObserver(() => {
			if (target.offsetWidth === 0 || target.offsetHeight === 0) return;
			managed.fitAddon.fit();
			clearTimeout(resizeTimerRef.current);
			resizeTimerRef.current = setTimeout(() => {
				if (managed.ptyId) {
					pty.resize(managed.ptyId, managed.term.cols, managed.term.rows);
				}
			}, 100);
		});
		resizeObserverRef.current.observe(target);
	}

	function retract(id: string, fallback: HTMLDivElement | null) {
		cleanupResizeObserver();
		const managed = getTerminal(id);
		if (!managed || !fallback) return;
		const termEl = managed.term.element;
		if (termEl && termEl.parentElement !== fallback) {
			fallback.appendChild(termEl);
		}
	}

	function cleanupResizeObserver() {
		clearTimeout(resizeTimerRef.current);
		resizeObserverRef.current?.disconnect();
		resizeObserverRef.current = null;
	}

	return (
		<div
			ref={stableRef}
			style={{
				position: "fixed",
				left: "-9999px",
				visibility: "hidden",
				width: 0,
				height: 0,
			}}
		/>
	);
}
