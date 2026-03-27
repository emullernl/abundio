import { useCallback, useEffect, useRef, useState } from "react";
import { pty } from "../../lib/ipc";
import type { ShellMeta } from "../../lib/oscParser";
import { PowerlinePrompt } from "./PowerlinePrompt";

interface Props {
	meta: ShellMeta | null;
	ptyId: string;
	isFocused: boolean;
	onExecute: (command: string) => void;
}

// Shared command history across all panes for the session
const commandHistory: string[] = [];
const MAX_HISTORY = 500;

export function PromptBar({ meta, ptyId, isFocused, onExecute }: Props) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [inputValue, setInputValue] = useState("");
	const [historyIndex, setHistoryIndex] = useState(-1);
	const savedInputRef = useRef("");

	useEffect(() => {
		if (isFocused) {
			inputRef.current?.focus();
		}
	}, [isFocused]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (!ptyId) return;

			const ctrl = e.ctrlKey || e.metaKey;

			// Enter: execute command
			if (e.key === "Enter") {
				e.preventDefault();
				if (inputValue.trim()) {
					if (commandHistory[0] !== inputValue) {
						commandHistory.unshift(inputValue);
						if (commandHistory.length > MAX_HISTORY) {
							commandHistory.pop();
						}
					}
				}
				onExecute(inputValue);
				setInputValue("");
				setHistoryIndex(-1);
				savedInputRef.current = "";
				return;
			}

			// Tab: send current input + tab for shell completion
			if (e.key === "Tab") {
				e.preventDefault();
				pty.write(ptyId, `${inputValue}\t`);
				setInputValue("");
				return;
			}

			// Ctrl+C: send interrupt
			if (ctrl && e.key === "c" && !e.shiftKey) {
				e.preventDefault();
				pty.write(ptyId, "\x03");
				setInputValue("");
				setHistoryIndex(-1);
				return;
			}

			// Ctrl+D: send EOF
			if (ctrl && e.key === "d") {
				e.preventDefault();
				pty.write(ptyId, "\x04");
				return;
			}

			// Ctrl+L: clear screen
			if (ctrl && e.key === "l") {
				e.preventDefault();
				pty.write(ptyId, "\x0c");
				return;
			}

			// Ctrl+U: kill line
			if (ctrl && e.key === "u") {
				e.preventDefault();
				setInputValue("");
				return;
			}

			// Ctrl+W: kill word
			if (ctrl && e.key === "w") {
				e.preventDefault();
				setInputValue((v) => v.replace(/\S+\s*$/, ""));
				return;
			}

			// Up arrow: navigate history (local)
			if (e.key === "ArrowUp") {
				e.preventDefault();
				if (commandHistory.length === 0) return;
				const newIndex = historyIndex + 1;
				if (newIndex >= commandHistory.length) return;
				if (historyIndex === -1) {
					savedInputRef.current = inputValue;
				}
				setHistoryIndex(newIndex);
				setInputValue(commandHistory[newIndex]);
				return;
			}

			// Down arrow: navigate history (local)
			if (e.key === "ArrowDown") {
				e.preventDefault();
				if (historyIndex <= -1) return;
				const newIndex = historyIndex - 1;
				setHistoryIndex(newIndex);
				if (newIndex === -1) {
					setInputValue(savedInputRef.current);
				} else {
					setInputValue(commandHistory[newIndex]);
				}
				return;
			}
		},
		[ptyId, inputValue, historyIndex, onExecute],
	);

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			setInputValue(e.target.value);
			setHistoryIndex(-1);
		},
		[],
	);

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				flexShrink: 0,
				background: "var(--bg-secondary)",
				overflow: "hidden",
			}}
		>
			{/* Top row: info pills */}
			<div style={{ padding: "6px 0 2px" }}>
				<PowerlinePrompt meta={meta} />
			</div>

			{/* Bottom row: $ input */}
			<div
				style={{
					display: "flex",
					alignItems: "center",
					padding: "2px 8px 6px",
				}}
			>
				<span
					style={{
						color: "var(--fg-secondary)",
						fontFamily: "var(--font-mono)",
						fontSize: 14,
						userSelect: "none",
						flexShrink: 0,
					}}
				>
					$
				</span>
				<input
					ref={inputRef}
					type="text"
					value={inputValue}
					onChange={handleChange}
					onKeyDown={handleKeyDown}
					spellCheck={false}
					autoComplete="off"
					autoCorrect="off"
					style={{
						flex: 1,
						background: "transparent",
						border: "none",
						outline: "none",
						color: "var(--fg-primary)",
						fontFamily: "var(--font-mono)",
						fontSize: 14,
						padding: "0 0 0 6px",
						caretColor: "var(--accent)",
					}}
				/>
			</div>
		</div>
	);
}
