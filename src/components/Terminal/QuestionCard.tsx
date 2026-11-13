import { MessageCircleQuestion, X } from "lucide-react";
import { useState } from "react";
import { useAgentHandle } from "../../hooks/useAgentHandle";
import {
	answerQuestion,
	dismissQuestion,
} from "../../lib/agentControl/askUser";
import { useAgentSignalsStore } from "../../stores/agentSignalsStore";
import {
	paramTextInputStyle,
	primaryButtonClass,
	secondaryButtonClass,
} from "../PromptActions/fieldStyles";

/**
 * The **Question card** (ADR-0056): an Agent's `abundio ask`, pinned below
 * its pane's terminal. It never takes focus by itself, so the user can keep
 * typing wherever they are. Choices are buttons; the text field, when
 * offered, is sent with Enter or Send. The close button (or Escape inside
 * the card) dismisses it, and the Agent's `ask` ends as `declined`.
 */
export function QuestionCard({ paneId }: { paneId: string }) {
	const q = useAgentSignalsStore((s) => s.questions[paneId]);
	const handle = useAgentHandle(paneId);
	const [text, setText] = useState("");
	if (!q) return null;

	const dismiss = () => {
		dismissQuestion(paneId, q.id);
		setText("");
	};

	const send = (choice: string | null) => {
		const typed = text.trim();
		answerQuestion(paneId, q.id, {
			choice,
			text: q.text && typed ? typed : null,
		});
		setText("");
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: keeps keys and clicks from reaching the terminal behind it
		<section
			className="shrink-0 flex flex-col"
			aria-label={`${handle ?? "The Agent"} asks`}
			onKeyDown={(e) => {
				e.stopPropagation();
				if (e.key === "Escape") {
					e.preventDefault();
					dismiss();
				}
			}}
			onMouseDown={(e) => e.stopPropagation()}
			style={{
				gap: 8,
				margin: "4px 8px 6px 0",
				padding: "10px 12px",
				borderRadius: 8,
				border:
					"1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
				backgroundColor:
					"color-mix(in srgb, var(--accent) 7%, var(--bg-secondary))",
			}}
		>
			<div className="flex items-start" style={{ gap: 8 }}>
				<span
					className="shrink-0 flex items-center"
					style={{ color: "var(--accent)", height: 18 }}
				>
					<MessageCircleQuestion size={14} />
				</span>
				<div className="min-w-0 flex-1 flex flex-col" style={{ gap: 2 }}>
					<span
						style={{
							fontSize: 11,
							color: "var(--fg-secondary)",
						}}
					>
						{handle ?? "The Agent"} asks
					</span>
					<span
						style={{
							fontSize: 13,
							lineHeight: "18px",
							color: "var(--fg-primary)",
							whiteSpace: "pre-wrap",
							overflowWrap: "anywhere",
							maxHeight: 120,
							overflowY: "auto",
						}}
					>
						{q.question}
					</span>
				</div>
				<button
					type="button"
					onClick={dismiss}
					aria-label="Dismiss the question"
					title="Dismiss without answering"
					className="shrink-0 flex items-center justify-center rounded cursor-pointer text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-tertiary)]"
					style={{ width: 20, height: 20 }}
				>
					<X size={13} />
				</button>
			</div>
			{q.choices.length > 0 && (
				<div className="flex flex-wrap" style={{ gap: 6 }}>
					{q.choices.map((c) => (
						<button
							key={c}
							type="button"
							className={`${secondaryButtonClass} rounded-md`}
							style={{ fontSize: 12, height: 28, padding: "0 12px" }}
							onClick={() => send(c)}
						>
							{c}
						</button>
					))}
				</div>
			)}
			{q.text && (
				<form
					className="flex"
					style={{ gap: 6 }}
					onSubmit={(e) => {
						e.preventDefault();
						if (text.trim()) send(null);
					}}
				>
					<input
						value={text}
						onChange={(e) => setText(e.target.value)}
						placeholder={
							q.choices.length > 0 ? "Or type an answer…" : "Type your answer…"
						}
						aria-label="Your answer"
						className="rounded-md"
						style={{ ...paramTextInputStyle, height: 28, fontSize: 12.5 }}
					/>
					<button
						type="submit"
						disabled={!text.trim()}
						className={`${primaryButtonClass} rounded-md`}
						style={{
							fontSize: 12,
							height: 28,
							padding: "0 14px",
							color: "var(--bg-primary)",
							backgroundColor: "var(--accent)",
							opacity: text.trim() ? 1 : 0.5,
						}}
					>
						Send
					</button>
				</form>
			)}
		</section>
	);
}
