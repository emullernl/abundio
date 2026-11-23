import { motion } from "framer-motion";
import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { hostsApi, listenToThisWindow, type SshPrompt } from "../lib/ipc";
import {
	paramTextInputStyle,
	primaryButtonClass,
	secondaryButtonClass,
} from "./PromptActions/fieldStyles";

/**
 * What the user's `ssh` asks while Abundio connects to a Host (phase 7d): a
 * password, a key's passphrase, a 2FA code, or whether to trust a new host
 * key. Rust aims each prompt at one Window; the answer goes straight back to
 * that ssh and is kept nowhere.
 */
export function SshPromptHost() {
	const [queue, setQueue] = useState<SshPrompt[]>([]);

	useEffect(() => {
		const off = listenToThisWindow<SshPrompt>("ssh-prompt", (event) =>
			setQueue((q) => [...q, event.payload]),
		);
		return () => {
			off.then((stop) => stop());
		};
	}, []);

	const prompt = queue[0];
	if (!prompt) return null;
	const done = (answer: string | null) => {
		void hostsApi.answerPrompt(prompt.id, answer).catch(() => {});
		setQueue((q) => q.slice(1));
	};
	return <SshPromptDialog key={prompt.id} prompt={prompt} onDone={done} />;
}

function SshPromptDialog({
	prompt,
	onDone,
}: {
	prompt: SshPrompt;
	onDone: (answer: string | null) => void;
}) {
	const [value, setValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	useEscapeKey(() => onDone(null));
	useEffect(() => inputRef.current?.focus(), []);

	const button = (label: string, answer: string | null, primary = false) => (
		<button
			type="button"
			className={`${primary ? primaryButtonClass : secondaryButtonClass} rounded-md`}
			style={{
				fontSize: 12,
				height: 30,
				padding: "0 14px",
				...(primary
					? { color: "white", backgroundColor: "var(--accent)" }
					: {}),
			}}
			onClick={() => onDone(answer)}
		>
			{label}
		</button>
	);

	return createPortal(
		<motion.div
			role="presentation"
			className="fixed inset-0 z-[210] flex items-center justify-center"
			style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
		>
			<motion.div
				role="dialog"
				aria-label={`ssh ${prompt.host}`}
				className="rounded-2xl flex flex-col gap-4"
				initial={{ opacity: 0, scale: 0.95, y: 10 }}
				animate={{ opacity: 1, scale: 1, y: 0 }}
				transition={{ duration: 0.15, ease: [0.2, 0, 0, 1] }}
				style={{
					width: 460,
					padding: "22px 24px",
					backgroundColor: "var(--bg-secondary)",
					border: "1px solid var(--border)",
					boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
				}}
				onKeyDown={(e) => e.stopPropagation()}
			>
				<div className="flex items-center gap-2">
					<KeyRound size={16} style={{ color: "var(--accent)" }} />
					<h2
						className="font-semibold"
						style={{ fontSize: 15, color: "var(--fg-primary)" }}
					>
						ssh {prompt.host}
					</h2>
				</div>
				<pre
					style={{
						fontSize: 12,
						color: "var(--fg-secondary)",
						fontFamily: "var(--font-mono)",
						whiteSpace: "pre-wrap",
						wordBreak: "break-word",
						margin: 0,
					}}
				>
					{prompt.text.trim()}
				</pre>
				{prompt.kind === "secret" && (
					<input
						ref={inputRef}
						type="password"
						className="rounded-md"
						style={paramTextInputStyle}
						value={value}
						autoComplete="off"
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") onDone(value);
						}}
					/>
				)}
				<div className="flex justify-end gap-2">
					{prompt.kind === "secret" && (
						<>
							{button("Cancel", null)}
							<button
								type="button"
								className={`${primaryButtonClass} rounded-md`}
								style={{
									fontSize: 12,
									height: 30,
									padding: "0 14px",
									color: "white",
									backgroundColor: "var(--accent)",
								}}
								onClick={() => onDone(value)}
							>
								Continue
							</button>
						</>
					)}
					{prompt.kind === "confirm" && (
						<>
							{button("No", "no")}
							{button("Yes, trust it", "yes", true)}
						</>
					)}
					{prompt.kind === "info" && button("OK", "", true)}
				</div>
			</motion.div>
		</motion.div>,
		document.body,
	);
}
