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

const WIDTH = 460;
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
					<header
						style={{
							padding: "16px 20px 14px",
							borderBottom: "1px solid var(--border)",
						}}
					>
						<h2 style={{ fontSize: 14, color: "var(--fg-primary)" }}>
							New prompt action
						</h2>
						<p
							style={{
								fontSize: 12,
								color: "var(--fg-secondary)",
								marginTop: 3,
								lineHeight: 1.45,
							}}
						>
							A button under this pane that sends a prompt to the agent.
						</p>
					</header>

					<div className="flex flex-col gap-5" style={{ padding: "20px" }}>
						<Field label="Button name">
							<input
								ref={nameRef}
								placeholder="Review changes"
								className="rounded-lg"
								style={textInputStyle}
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</Field>

						<Field
							label="Sends"
							hint={
								derived.length > 0
									? `Asks for ${derived.length} ${
											derived.length === 1 ? "value" : "values"
										} before sending`
									: "Wrap a word in {{ }} to be asked for it first"
							}
						>
							<textarea
								placeholder="/review"
								className="rounded-lg"
								style={{
									...bodyInputStyle,
									minHeight: 92,
									resize: "vertical",
								}}
								value={body}
								onChange={(e) => setBody(e.target.value)}
							/>
						</Field>

						{/* Parameters appear as you type placeholders — the name lives in
						    the body and nowhere else, so there is nothing to declare. */}
						{derived.length > 0 && (
							<Field label="Asks for">
								<div className="flex flex-col gap-2">
									{derived.map((p) => (
										<div
											key={p.name}
											className="flex items-center gap-3 rounded-lg"
											style={{
												padding: "0 12px",
												height: 40,
												backgroundColor: "var(--bg-primary)",
												border: "1px solid var(--border)",
											}}
										>
											<span
												className="truncate flex-1"
												style={{
													fontFamily: "var(--font-mono)",
													fontSize: 12,
													color: "var(--fg-primary)",
												}}
											>
												{p.name}
											</span>
											<select
												className="rounded-md"
												style={{ ...selectStyle, width: 132 }}
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
								</div>
							</Field>
						)}

						{defaultAgentId && (
							<Field label="Offered for">
								{/* A segmented pair rather than a bare checkbox: the choice is
								    between two named things, and "only for X" as a tickbox
								    hides the alternative it is toggling away from. */}
								<div
									className="flex rounded-lg gap-1"
									style={{
										padding: 4,
										backgroundColor: "var(--bg-primary)",
										border: "1px solid var(--border)",
									}}
								>
									<ScopeChoice
										selected={scopeToAgent}
										onClick={() => setScopeToAgent(true)}
									>
										{agentName ?? defaultAgentId} only
									</ScopeChoice>
									<ScopeChoice
										selected={!scopeToAgent}
										onClick={() => setScopeToAgent(false)}
									>
										All agents
									</ScopeChoice>
								</div>
							</Field>
						)}
					</div>

					<footer
						className="flex items-center justify-between gap-3"
						style={{
							padding: "14px 20px",
							borderTop: "1px solid var(--border)",
						}}
					>
						<button
							type="button"
							className="inline-flex items-center gap-1 transition-opacity hover:opacity-100"
							style={{
								fontSize: 12,
								color: "var(--fg-secondary)",
								opacity: 0.8,
							}}
							onClick={() => {
								invoke("open_settings_window", {
									section: "prompt-actions",
								}).catch(() => {});
								onClose();
							}}
						>
							Edit in Settings
							<ArrowUpRight size={12} />
						</button>
						<div className="flex items-center gap-2">
							<button
								type="button"
								className="rounded-lg"
								style={{
									padding: "0 16px",
									height: 34,
									fontSize: 13,
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
								className="rounded-lg"
								style={{
									padding: "0 16px",
									height: 34,
									fontSize: 13,
									fontWeight: 500,
									backgroundColor: "var(--accent)",
									color: "var(--bg-primary)",
									opacity: ready ? 1 : 0.35,
									cursor: ready ? "pointer" : "not-allowed",
								}}
								onClick={save}
							>
								Add action
							</button>
						</div>
					</footer>
				</motion.div>
			</motion.div>
		</AnimatePresence>
	);
}

/** Label over control. The label is UI-font sentence case, not 10px lowercase
 *  mono — mono is for the prompt body and the placeholder names, which are
 *  code; a form label is prose and should read like the rest of the app. */
function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2">
			<span style={{ fontSize: 12, color: "var(--fg-primary)", opacity: 0.85 }}>
				{label}
			</span>
			{children}
			{hint && (
				<span
					style={{
						fontSize: 11,
						color: "var(--fg-secondary)",
						opacity: 0.75,
						lineHeight: 1.4,
					}}
				>
					{hint}
				</span>
			)}
		</div>
	);
}

function ScopeChoice({
	selected,
	onClick,
	children,
}: {
	selected: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			className="flex-1 rounded-md truncate transition-colors"
			style={{
				height: 30,
				fontSize: 12,
				color: selected ? "var(--bg-primary)" : "var(--fg-secondary)",
				backgroundColor: selected ? "var(--accent)" : "transparent",
			}}
			onClick={onClick}
		>
			{children}
		</button>
	);
}

const fieldBase: React.CSSProperties = {
	color: "var(--fg-primary)",
	backgroundColor: "var(--bg-primary)",
	border: "1px solid var(--border)",
	outline: "none",
	width: "100%",
	// Inline, and on the base so no variant can forget it: every `p-*` utility
	// in this app is dead (globals.css:273 has an unlayered `* { padding: 0 }`
	// reset, and an unlayered normal declaration beats a layered one whatever
	// its specificity). A control with no padding puts its text and its
	// placeholder hard against the border. See the note in SettingsPanel.tsx.
	padding: "0 12px",
};

/** The UI font at 13px — a name is prose, not code. */
const textInputStyle: React.CSSProperties = {
	...fieldBase,
	fontSize: 13,
	height: 36,
};

/** Mono, because this one really is a prompt the agent will read verbatim and
 *  its `{{placeholders}}` are tokens. */
const bodyInputStyle: React.CSSProperties = {
	...fieldBase,
	fontFamily: "var(--font-mono)",
	fontSize: 12.5,
	lineHeight: 1.55,
	padding: "10px 12px",
};

const selectStyle: React.CSSProperties = {
	...fieldBase,
	fontSize: 12,
	height: 30,
	width: "auto",
	padding: "0 8px",
};
