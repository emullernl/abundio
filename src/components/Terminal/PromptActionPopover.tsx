/**
 * The in-pane authoring popover: the `+` at the end of the **Action bar**, and
 * **Add prompt action…** in the pane context menu.
 *
 * Deliberately *not* the Settings window. Settings is a singleton auxiliary
 * Window (ADR-0008) — an OS-level window that opens or focuses and steals the
 * screen from the terminal you are working in. Clicking `+` to make a small
 * button and having a second application window take over is the opposite of
 * "directly from the pane".
 *
 * Equally deliberately the **smaller** of the two editors. Name, body, scope
 * and the derived parameter types live here; reordering, duplication and
 * deletion stay in Settings. Two editors for one object drift unless one of
 * them is consciously kept narrow.
 */

import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	type ActionScope,
	deriveParams,
	type ParamMeta,
	type ParamMetaMap,
	type ParamType,
} from "../../lib/promptActions";
import { usePromptActionStore } from "../../stores/promptActionStore";
import { useSettingsStore } from "../../stores/settingsStore";

interface PromptActionPopoverProps {
	anchor: { x: number; y: number };
	/** The Agent this pane resolved to, if any. Seeds the scope. */
	defaultAgentId: string | undefined;
	onClose: () => void;
}

const WIDTH = 420;
const PARAM_TYPES: ParamType[] = [
	"text",
	"number",
	"choice",
	"toggle",
	"attachment",
];

export function PromptActionPopover({
	anchor,
	defaultAgentId,
	onClose,
}: PromptActionPopoverProps) {
	const nameRef = useRef<HTMLInputElement>(null);
	const [name, setName] = useState("");
	const [body, setBody] = useState("");
	const [params, setParams] = useState<ParamMetaMap>({});

	// Scope defaults to *this pane's Agent*, not to all agents. The motivating
	// case is a slash command, and slash commands are agent-specific — `/review`
	// typed at an Agent that does not have it is just a line of text. Defaulting
	// to `all` would quietly put broken buttons in every other Agent's bar.
	//
	// With no resolved Agent id, `all` is the only honest answer available.
	const [scopeToAgent, setScopeToAgent] = useState(!!defaultAgentId);

	const createAction = usePromptActionStore((s) => s.createAction);
	const agents = useSettingsStore((s) => s.agents);
	const agentName = useMemo(
		() => agents.find((a) => a.id === defaultAgentId)?.name,
		[agents, defaultAgentId],
	);

	const derived = useMemo(() => deriveParams(body, params), [body, params]);

	useEffect(() => {
		nameRef.current?.focus();
	}, []);

	const ready = name.trim().length > 0 && body.trim().length > 0;

	async function save() {
		if (!ready) return;
		const scope: ActionScope =
			scopeToAgent && defaultAgentId
				? { kind: "set", agentIds: [defaultAgentId] }
				: { kind: "all" };
		// Only metadata for parameters the body still refers to — an entry whose
		// placeholder was deleted mid-edit is inert, but there is no reason to
		// persist it.
		const live: ParamMetaMap = {};
		for (const p of derived) live[p.name] = p.meta;
		await createAction({ name: name.trim(), body, scope, params: live });
		onClose();
	}

	// Keep the card on screen: it is anchored to a `+` that may sit near the
	// right or bottom edge of a small pane.
	const left = Math.max(
		8,
		Math.min(anchor.x - WIDTH, window.innerWidth - WIDTH - 8),
	);
	const bottom = Math.max(8, window.innerHeight - anchor.y + 6);

	return (
		<AnimatePresence>
			<motion.div
				role="presentation"
				className="fixed inset-0 z-[150]"
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				exit={{ opacity: 0 }}
				transition={{ duration: 0.12 }}
				onClick={onClose}
				onKeyDown={(e) => e.key === "Escape" && onClose()}
			>
				<motion.div
					role="dialog"
					aria-label="Add prompt action"
					className="absolute rounded-xl overflow-hidden flex flex-col"
					initial={{ opacity: 0, y: 6, scale: 0.98 }}
					animate={{ opacity: 1, y: 0, scale: 1 }}
					exit={{ opacity: 0, y: 6, scale: 0.98 }}
					transition={{ duration: 0.14, ease: [0.2, 0, 0, 1] }}
					style={{
						left,
						bottom,
						width: WIDTH,
						backgroundColor: "var(--bg-secondary)",
						border: "1px solid var(--border)",
						boxShadow: "0 18px 44px rgba(0,0,0,0.45)",
					}}
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
				>
					<div className="flex flex-col gap-4 px-5 py-4">
						<input
							ref={nameRef}
							placeholder="Button name"
							className="rounded-lg px-3 py-2"
							style={inputStyle}
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>

						<div className="flex flex-col gap-1">
							<textarea
								placeholder="What to send. Use {{name}} for a value to ask for."
								className="rounded-lg px-3 py-2"
								style={{ ...inputStyle, resize: "vertical" }}
								rows={4}
								value={body}
								onChange={(e) => setBody(e.target.value)}
							/>
							{derived.length > 0 && (
								<span
									style={{
										fontFamily: "var(--font-mono)",
										fontSize: 10,
										color: "var(--fg-secondary)",
										opacity: 0.6,
									}}
								>
									asks for {derived.length}{" "}
									{derived.length === 1 ? "value" : "values"} before sending
								</span>
							)}
						</div>

						{/* Parameters appear as you type placeholders — the name lives in
						    the body and nowhere else, so there is nothing to declare. */}
						{derived.map((p) => (
							<div key={p.name} className="flex items-center gap-2.5">
								<span
									className="truncate"
									style={{
										fontFamily: "var(--font-mono)",
										fontSize: 11,
										color: "var(--fg-primary)",
										minWidth: 90,
									}}
								>
									{p.name}
								</span>
								<select
									className="rounded-md px-2.5 py-1.5 flex-1"
									style={{ ...inputStyle, fontSize: 11 }}
									value={p.meta.type}
									onChange={(e) =>
										setParams((m) => ({
											...m,
											[p.name]: {
												...(m[p.name] ?? { type: "text" }),
												type: e.target.value as ParamType,
											} as ParamMeta,
										}))
									}
								>
									{PARAM_TYPES.map((t) => (
										<option key={t} value={t}>
											{t}
										</option>
									))}
								</select>
							</div>
						))}

						{defaultAgentId && (
							<label
								className="flex items-center gap-2 cursor-pointer"
								style={{ fontSize: 11, color: "var(--fg-secondary)" }}
							>
								<input
									type="checkbox"
									checked={scopeToAgent}
									onChange={(e) => setScopeToAgent(e.target.checked)}
								/>
								Only for {agentName ?? defaultAgentId}
							</label>
						)}
					</div>

					<div
						className="flex items-center justify-between gap-3 px-5 py-3.5"
						style={{ borderTop: "1px solid var(--border)" }}
					>
						<button
							type="button"
							className="inline-flex items-center gap-1 transition-opacity"
							style={{
								fontSize: 11,
								color: "var(--fg-secondary)",
								opacity: 0.7,
							}}
							onClick={() => {
								invoke("open_settings_window", {
									section: "prompt-actions",
								}).catch(() => {});
								onClose();
							}}
						>
							Edit in Settings
							<ArrowUpRight size={11} />
						</button>
						<div className="flex items-center gap-2">
							<button
								type="button"
								className="rounded-lg px-3.5 py-2"
								style={{
									fontSize: 12,
									color: "var(--fg-secondary)",
									border: "1px solid var(--border)",
								}}
								onClick={onClose}
							>
								Cancel
							</button>
							<button
								type="button"
								disabled={!ready}
								className="rounded-lg px-3.5 py-2"
								style={{
									fontSize: 12,
									backgroundColor: "var(--accent)",
									color: "var(--bg-primary)",
									opacity: ready ? 1 : 0.35,
									cursor: ready ? "pointer" : "not-allowed",
								}}
								onClick={save}
							>
								Add
							</button>
						</div>
					</div>
				</motion.div>
			</motion.div>
		</AnimatePresence>
	);
}

const inputStyle: React.CSSProperties = {
	fontFamily: "var(--font-mono)",
	fontSize: 12,
	color: "var(--fg-primary)",
	backgroundColor: "var(--bg-primary)",
	border: "1px solid var(--border)",
	outline: "none",
	width: "100%",
};
