import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { pty } from "../../lib/ipc";
import { useSettingsStore } from "../../stores/settingsStore";
import "@xterm/xterm/css/xterm.css";

interface Props {
	ptyId: string;
	cwd: string;
	isFocused: boolean;
	onFocus: () => void;
}

export function TerminalPane({ ptyId: initialPtyId, cwd, isFocused, onFocus }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const activePtyIdRef = useRef(initialPtyId);
	const { fontFamily, fontSize } = useSettingsStore();

	useEffect(() => {
		if (!containerRef.current) return;

		const term = new Terminal({
			fontSize,
			fontFamily,
			cursorBlink: true,
			allowProposedApi: true,
			theme: {
				background: "#0D1117",
				foreground: "#E6EDF3",
				cursor: "#58D5BA",
				selectionBackground: "#264F78",
				black: "#484F58",
				red: "#FF7B72",
				green: "#3FB950",
				yellow: "#D29922",
				blue: "#58A6FF",
				magenta: "#BC8CFF",
				cyan: "#58D5BA",
				white: "#E6EDF3",
				brightBlack: "#6E7681",
				brightRed: "#FFA198",
				brightGreen: "#56D364",
				brightYellow: "#E3B341",
				brightBlue: "#79C0FF",
				brightMagenta: "#D2A8FF",
				brightCyan: "#7EE2CC",
				brightWhite: "#FFFFFF",
			},
		});

		const fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		term.loadAddon(new SearchAddon());
		term.loadAddon(new WebLinksAddon());
		term.open(containerRef.current);

		// GPU acceleration — fallback to canvas if WebGL2 unavailable
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => webgl.dispose());
			term.loadAddon(webgl);
		} catch {
			// Canvas renderer is the default — no action needed
		}

		fitAddon.fit();
		termRef.current = term;

		// Spawn PTY if needed (empty ptyId means "spawn on activate")
		let currentPtyId = initialPtyId;

		async function initPty() {
			if (!currentPtyId) {
				currentPtyId = await pty.spawn(cwd, term.cols, term.rows);
				activePtyIdRef.current = currentPtyId;
			}

			// Input: terminal → PTY
			term.onData((data) => {
				pty.write(currentPtyId, data);
			});

			// Output: PTY → terminal (binary)
			const unlistenOutput = await pty.onOutput(currentPtyId, (data) => {
				term.write(data);
			});

			// Resize: debounced
			let resizeTimer: ReturnType<typeof setTimeout>;
			const resizeObserver = new ResizeObserver(() => {
				fitAddon.fit();
				clearTimeout(resizeTimer);
				resizeTimer = setTimeout(() => {
					pty.resize(currentPtyId, term.cols, term.rows);
				}, 100);
			});
			resizeObserver.observe(containerRef.current!);

			// Store cleanup references
			return () => {
				unlistenOutput();
				clearTimeout(resizeTimer);
				resizeObserver.disconnect();
				pty.kill(currentPtyId);
				term.dispose();
			};
		}

		const cleanupPromise = initPty();

		return () => {
			cleanupPromise.then((cleanup) => cleanup?.());
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cwd]);

	useEffect(() => {
		if (isFocused) termRef.current?.focus();
	}, [isFocused]);

	return (
		<div
			ref={containerRef}
			className="w-full h-full"
			style={{
				padding: 0,
				overflow: "hidden",
				boxShadow: isFocused ? "0 0 0 1px var(--accent)" : "none",
			}}
			onFocus={onFocus}
			onMouseDown={onFocus}
		/>
	);
}
