import { memo, useCallback, useEffect, useRef } from "react";
import { pty } from "../../lib/ipc";
import { getTarget, onTargetChange } from "../../lib/portalRegistry";
import {
	beginResizeFilter,
	createTerminal,
	destroyTerminal,
	ensureWebglLoaded,
	flushPendingRestore,
	getTerminal,
	markSettled,
} from "../../lib/terminalManager";
import { getTheme } from "../../lib/themes";
import { useSettingsStore } from "../../stores/settingsStore";
import "@xterm/xterm/css/xterm.css";

interface Props {
	paneId: string;
	ptyId: string;
	cwd: string;
}

export const TerminalInstance = memo(function TerminalInstance({
	paneId,
	ptyId,
	cwd,
}: Props) {
	const stableRef = useRef<HTMLDivElement>(null);
	const ptyIdRef = useRef(ptyId);
	const destroyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const resizeObserverRef = useRef<ResizeObserver | null>(null);
	const resizeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const rafRef = useRef<number | null>(null);

	const cleanupResizeObserver = useCallback(() => {
		clearTimeout(resizeTimerRef.current);
		if (rafRef.current !== null) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
		}
		resizeObserverRef.current?.disconnect();
		resizeObserverRef.current = null;
	}, []);

	const projectInto = useCallback(
		(id: string, target: HTMLDivElement) => {
			const managed = getTerminal(id);
			if (!managed) return;

			const termEl = managed.term.element;

			// Hide terminal during projection to prevent flicker from fit/restore/resize
			if (termEl) termEl.style.visibility = "hidden";

			if (termEl && termEl.parentElement !== target) {
				target.appendChild(termEl);
			}

			managed.fitAddon.fit();
			// Retry WebGL loading now that the terminal is in a visible, sized
			// container. The first attempt during createTerminal runs while the
			// canvas is still 0×0 offscreen, which some browsers refuse — if that
			// failed, xterm silently fell back to its DOM renderer and we'd see
			// wrong glyph metrics. This is a no-op when WebGL is already loaded.
			ensureWebglLoaded(id);
			flushPendingRestore(id);
			if (managed.ptyId) {
				// Filter reset sequences from the shell's resize response to
				// prevent it from wiping terminal content (Windows session switch).
				beginResizeFilter(id);
				pty
					.resize(managed.ptyId, managed.term.cols, managed.term.rows)
					.catch(() => {});
			}

			// Reveal after the browser has painted the settled content
			requestAnimationFrame(() => {
				if (termEl) termEl.style.visibility = "";
				markSettled(id);
			});

			// Observe the target for resize — throttle fit() to one call per frame
			cleanupResizeObserver();
			resizeObserverRef.current = new ResizeObserver(() => {
				if (target.offsetWidth === 0 || target.offsetHeight === 0) return;
				if (rafRef.current !== null) return;
				rafRef.current = requestAnimationFrame(() => {
					rafRef.current = null;
					const prevCols = managed.term.cols;
					const prevRows = managed.term.rows;
					managed.fitAddon.fit();
					// Only send PTY resize when grid dimensions actually changed
					if (
						managed.ptyId &&
						(managed.term.cols !== prevCols || managed.term.rows !== prevRows)
					) {
						clearTimeout(resizeTimerRef.current);
						resizeTimerRef.current = setTimeout(() => {
							pty.resize(managed.ptyId, managed.term.cols, managed.term.rows);
						}, 100);
					}
				});
			});
			resizeObserverRef.current.observe(target);
		},
		[cleanupResizeObserver],
	);

	const retract = useCallback(
		(id: string, fallback: HTMLDivElement | null) => {
			cleanupResizeObserver();
			const managed = getTerminal(id);
			if (!managed || !fallback) return;
			const termEl = managed.term.element;
			if (termEl && termEl.parentElement !== fallback) {
				fallback.appendChild(termEl);
			}
		},
		[cleanupResizeObserver],
	);

	useEffect(() => {
		if (!stableRef.current) return;

		// Cancel any pending deferred destroy from a previous cleanup (StrictMode
		// unmounts and immediately remounts — the terminal should survive that).
		clearTimeout(destroyTimerRef.current);

		let cancelled = false;

		const init = async () => {
			if (cancelled || !stableRef.current) return;

			// Only create if not already existing (survives StrictMode remount)
			if (!getTerminal(paneId)) {
				const {
					terminalFontFamily,
					fontSize,
					theme: themeName,
				} = useSettingsStore.getState();
				const currentTheme = getTheme(themeName);
				await createTerminal(paneId, ptyIdRef.current, cwd, stableRef.current, {
					fontSize,
					fontFamily: terminalFontFamily,
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
			// Defer destruction so StrictMode's immediate remount can cancel it.
			// On real unmount the timeout fires and the terminal is destroyed.
			destroyTimerRef.current = setTimeout(() => destroyTerminal(paneId), 0);
		};
		// ptyId intentionally excluded — it's an initial value captured in ptyIdRef.
		// Including it would cause a destroy+recreate cycle when initPty writes the
		// generated UUID back to the layout store.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [paneId, cwd, projectInto, retract, cleanupResizeObserver]);

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
});
