import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { HANDLE_MAX_LENGTH, handleGrammarProblem } from "../../lib/agentHandle";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	paramTextInputStyle,
	primaryButtonClass,
	secondaryButtonClass,
} from "../PromptActions/fieldStyles";

interface Props {
	paneId: string;
	current: string | undefined;
	onClose: () => void;
}

/**
 * "Name agent…" from the pane menu: set or clear the pane's **Agent handle**,
 * the name other Agents address it by. An empty name clears it.
 */
function NameAgentDialogBody({ paneId, current, onClose }: Props) {
	const [value, setValue] = useState(current ?? "");
	const [refusal, setRefusal] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	useEscapeKey(onClose);

	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);

	const trimmed = value.trim();
	const clearing = trimmed === "";
	const problem = clearing ? null : handleGrammarProblem(trimmed);
	const canSave = clearing ? current !== undefined : problem === null;
	const message = problem ?? refusal;

	const save = () => {
		if (!canSave) return;
		const result = useWorkspaceStore
			.getState()
			.setAgentHandle(paneId, clearing ? null : trimmed);
		if (result.ok) onClose();
		else setRefusal(result.message);
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop click dismisses; Escape is handled by useEscapeKey
		<div
			role="presentation"
			className="fixed inset-0 z-[200] flex items-center justify-center"
			style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
			onClick={onClose}
		>
			<div
				role="dialog"
				aria-label="Name agent"
				className="rounded-2xl flex flex-col"
				style={{
					width: 400,
					gap: 12,
					padding: "20px 22px",
					backgroundColor: "var(--bg-secondary)",
					border: "1px solid var(--border)",
					boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
				}}
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => {
					e.stopPropagation();
					if (e.key === "Enter") {
						e.preventDefault();
						save();
					}
				}}
			>
				<h2
					className="font-semibold"
					style={{ color: "var(--fg-primary)", fontSize: 15 }}
				>
					Name agent
				</h2>
				<p style={{ color: "var(--fg-secondary)", fontSize: 13 }}>
					Other agents in this Workspace can address this one by its name, for
					example <code>abundio agent prompt reviewer …</code>. Leave it empty
					to remove the name.
				</p>
				<input
					ref={inputRef}
					value={value}
					maxLength={HANDLE_MAX_LENGTH + 8}
					spellCheck={false}
					autoCapitalize="off"
					autoCorrect="off"
					placeholder="Reviewer"
					onChange={(e) => {
						setValue(e.target.value);
						setRefusal(null);
					}}
					className="rounded-lg"
					style={{ ...paramTextInputStyle, fontFamily: "var(--font-mono)" }}
				/>
				<p
					style={{
						fontSize: 12,
						minHeight: 16,
						color: message ? "var(--error)" : "var(--fg-secondary)",
					}}
				>
					{message ?? "Letters, digits, spaces, - and _."}
				</p>
				<div className="flex justify-end" style={{ gap: 8 }}>
					<button
						type="button"
						onClick={onClose}
						className={`${secondaryButtonClass} rounded-lg`}
						style={{ padding: "0 14px", height: 34, fontSize: 13 }}
					>
						Cancel
					</button>
					<button
						type="button"
						disabled={!canSave}
						onClick={save}
						className={`${primaryButtonClass} rounded-lg`}
						style={{
							padding: "0 16px",
							height: 34,
							fontSize: 13,
							fontWeight: 500,
							backgroundColor: "var(--accent)",
							color: "var(--bg-primary)",
							opacity: canSave ? 1 : 0.35,
						}}
					>
						{clearing && current !== undefined ? "Remove name" : "Save"}
					</button>
				</div>
			</div>
		</div>
	);
}

/** Portaled, like the pane menu, so a Fleet tile's transform cannot clip it. */
export function NameAgentDialog(props: Props) {
	return createPortal(<NameAgentDialogBody {...props} />, document.body);
}
