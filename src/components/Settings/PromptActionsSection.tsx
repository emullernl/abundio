/**
 * Settings ▸ Prompt actions — the full editor.
 *
 * The larger of the two authoring surfaces. The in-pane popover covers "make a
 * button now"; everything structural lives here: scope across several Agents,
 * parameter defaults and choice options, **Show in bar**, reordering, deletion.
 *
 * Reordering matters more than it looks. A bar button's **position number** is
 * the digit that fires it, so moving a row here moves a keyboard shortcut.
 *
 * ## Type
 *
 * Monospace is reserved for the two things that really are code — the prompt
 * **body**, which the Agent reads verbatim, and a **parameter name**, which is
 * a `{{token}}` inside that body. Labels, action names, hints and controls use
 * the UI font at the sizes the rest of Settings uses (13px content, 11–12px
 * supporting). Mono at the same nominal size reads considerably denser, and a
 * form built entirely from it looks like a config file rather than a form.
 *
 * The column is width-capped. Other sections never needed this — they are
 * toggle cards and grids — but a text input stretched across an ultrawide
 * window is unusable, and a name field has no business being 1500px wide.
 */

import { useEffect, useMemo, useState } from "react";
import {
	type ActionScope,
	deriveParams,
	type ParamMeta,
	type ParamMetaMap,
	type PromptAction,
} from "../../lib/promptActions";
import { usePromptActionStore } from "../../stores/promptActionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { ChevronDown, ChevronRight, Plus, X } from "../Icons";
import {
	paramBodyInputStyle as bodyInputStyle,
	paramSelectStyle as selectStyle,
	paramTextInputStyle as textInputStyle,
} from "../PromptActions/fieldStyles";
import { ParameterEditor } from "../PromptActions/ParameterEditor";
import { SectionLabel, ToggleRow } from "./primitives";

/** A form is unreadable stretched across an ultrawide window. */
const COLUMN = 760;

export function PromptActionsSection() {
	const actions = usePromptActionStore((s) => s.actions);
	const load = usePromptActionStore((s) => s.load);
	const createAction = usePromptActionStore((s) => s.createAction);
	const reorderActions = usePromptActionStore((s) => s.reorderActions);
	const [expanded, setExpanded] = useState<string | null>(null);

	useEffect(() => {
		void load();
	}, [load]);

	async function add() {
		const created = await createAction({ name: "New action", body: "" });
		if (created) setExpanded(created.id);
	}

	function move(id: string, delta: number) {
		const ids = actions.map((a) => a.id);
		const from = ids.indexOf(id);
		const to = from + delta;
		if (from < 0 || to < 0 || to >= ids.length) return;
		ids.splice(to, 0, ...ids.splice(from, 1));
		void reorderActions(ids);
	}

	return (
		<div
			className="flex flex-col gap-6 overflow-y-auto"
			style={{ maxWidth: COLUMN }}
		>
			<div>
				<SectionLabel>Prompt actions</SectionLabel>
				<p
					style={{
						fontSize: 13,
						color: "var(--fg-secondary)",
						lineHeight: 1.6,
						marginBottom: 18,
					}}
				>
					One-click prompts for a running agent, shown along the bottom of its
					pane. Order decides the keyboard shortcut — the first nine get{" "}
					<Shortcut n={1} /> through <Shortcut n={9} />.
				</p>

				{actions.length === 0 ? (
					<EmptyState onAdd={add} />
				) : (
					<div className="flex flex-col gap-2.5">
						{actions.map((action, i) => (
							<ActionRow
								key={action.id}
								action={action}
								slot={i + 1}
								canMoveUp={i > 0}
								canMoveDown={i < actions.length - 1}
								expanded={expanded === action.id}
								onToggle={() =>
									setExpanded((e) => (e === action.id ? null : action.id))
								}
								onMove={(d) => move(action.id, d)}
							/>
						))}
					</div>
				)}
			</div>

			{actions.length > 0 && (
				<button
					type="button"
					className="self-start inline-flex items-center gap-2 rounded-lg transition-colors"
					style={{
						padding: "0 14px",
						height: 36,
						fontSize: 13,
						color: "var(--fg-primary)",
						border: "1px solid var(--border)",
						backgroundColor: "var(--bg-primary)",
					}}
					onClick={add}
				>
					<Plus />
					Add action
				</button>
			)}
		</div>
	);
}

function Shortcut({ n }: { n: number }) {
	const label = navigator.platform.startsWith("Mac")
		? `⌘${n}`
		: `Ctrl+Shift+${n}`;
	return (
		<kbd
			style={{
				fontFamily: "var(--font-mono)",
				fontSize: 11,
				padding: "2px 6px",
				borderRadius: 4,
				border: "1px solid var(--border)",
				color: "var(--fg-primary)",
				whiteSpace: "nowrap",
			}}
		>
			{label}
		</kbd>
	);
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
	return (
		<div
			className="rounded-xl flex flex-col items-start gap-4"
			style={{
				padding: "26px 24px",
				border: "1px dashed color-mix(in srgb, var(--border) 85%, transparent)",
				backgroundColor: "var(--bg-primary)",
			}}
		>
			<p
				style={{ fontSize: 13, color: "var(--fg-secondary)", lineHeight: 1.65 }}
			>
				Nothing yet. Abundio ships no built-in actions on purpose — a stock
				“/review” button would assume a slash command only some installs have,
				and fail on first click. Add your own here, or from the{" "}
				<span style={{ fontFamily: "var(--font-mono)" }}>⋯</span> menu in any
				agent pane.
			</p>
			<button
				type="button"
				className="inline-flex items-center gap-2 rounded-lg"
				style={{
					padding: "0 16px",
					height: 36,
					fontSize: 13,
					fontWeight: 500,
					backgroundColor: "var(--accent)",
					color: "var(--bg-primary)",
				}}
				onClick={onAdd}
			>
				<Plus />
				Add your first action
			</button>
		</div>
	);
}

interface ActionRowProps {
	action: PromptAction;
	slot: number;
	canMoveUp: boolean;
	canMoveDown: boolean;
	expanded: boolean;
	onToggle: () => void;
	onMove: (delta: number) => void;
}

function ActionRow({
	action,
	slot,
	canMoveUp,
	canMoveDown,
	expanded,
	onToggle,
	onMove,
}: ActionRowProps) {
	const updateAction = usePromptActionStore((s) => s.updateAction);
	const deleteAction = usePromptActionStore((s) => s.deleteAction);
	const agents = useSettingsStore((s) => s.agents);

	const derived = useMemo(
		() => deriveParams(action.body, action.params),
		[action.body, action.params],
	);

	const orphanedScope =
		action.scope.kind === "set" && action.scope.agentIds.length === 0;
	const scopeLabel =
		action.scope.kind === "all"
			? "All agents"
			: orphanedScope
				? "No agents selected"
				: action.scope.agentIds
						.map((id) => agents.find((a) => a.id === id)?.name ?? id)
						.join(", ");

	function setParam(name: string, patch: Partial<ParamMeta>) {
		const next: ParamMetaMap = {
			...action.params,
			[name]: { ...(action.params[name] ?? { type: "text" }), ...patch },
		};
		void updateAction(action.id, { params: next });
	}

	const numbered = action.showInBar && slot <= 9;

	return (
		<div
			className="rounded-xl overflow-hidden"
			style={{
				border: "1px solid var(--border)",
				backgroundColor: "var(--bg-primary)",
			}}
		>
			<div
				className="flex items-center gap-3"
				style={{ height: 52, padding: "0 14px" }}
			>
				<button
					type="button"
					aria-label={expanded ? "Collapse" : "Expand"}
					className="shrink-0"
					style={{ color: "var(--fg-secondary)", lineHeight: 0 }}
					onClick={onToggle}
				>
					{expanded ? <ChevronDown /> : <ChevronRight />}
				</button>

				{/* The digit that fires this button. Blank past the ninth, rather than
				    a number nothing will fire. */}
				<span
					className="shrink-0 inline-flex items-center justify-center tabular-nums rounded-md"
					style={{
						width: 22,
						height: 22,
						fontFamily: "var(--font-mono)",
						fontSize: 11,
						color: numbered ? "var(--fg-primary)" : "var(--fg-secondary)",
						opacity: numbered ? 1 : 0.3,
						backgroundColor: numbered
							? "color-mix(in srgb, var(--fg-primary) 8%, transparent)"
							: "transparent",
					}}
					title={numbered ? `Fires with shortcut ${slot}` : "Not in the bar"}
				>
					{numbered ? slot : "–"}
				</span>

				<button
					type="button"
					className="truncate text-left flex-1 min-w-0"
					style={{ fontSize: 13, color: "var(--fg-primary)" }}
					onClick={onToggle}
				>
					{action.name}
				</button>

				<span
					className="truncate shrink-0 rounded-md"
					style={{
						padding: "0 8px",
						fontSize: 11,
						lineHeight: "20px",
						maxWidth: 200,
						color: orphanedScope
							? "var(--warning, #d99a2b)"
							: "var(--fg-secondary)",
						backgroundColor:
							"color-mix(in srgb, var(--border) 45%, transparent)",
					}}
					title={scopeLabel}
				>
					{scopeLabel}
				</span>

				<div className="flex items-center gap-0.5 shrink-0">
					<IconButton
						label="Move up"
						title="Move up — changes its keyboard shortcut"
						disabled={!canMoveUp}
						onClick={() => onMove(-1)}
						flip
					/>
					<IconButton
						label="Move down"
						title="Move down — changes its keyboard shortcut"
						disabled={!canMoveDown}
						onClick={() => onMove(1)}
					/>
					<IconButton
						label={`Delete ${action.name}`}
						title="Delete"
						onClick={() => void deleteAction(action.id)}
						icon={<X />}
					/>
				</div>
			</div>

			{expanded && (
				<div
					className="flex flex-col gap-5"
					style={{
						padding: "20px 14px",
						borderTop: "1px solid var(--border)",
						backgroundColor: "var(--bg-secondary)",
					}}
				>
					<Field label="Button name">
						<input
							className="rounded-lg"
							style={textInputStyle}
							value={action.name}
							onChange={(e) =>
								void updateAction(action.id, { name: e.target.value })
							}
						/>
					</Field>

					<Field
						label="Sends"
						hint="Wrap a word in double braces to be asked for it before sending."
					>
						<textarea
							className="rounded-lg"
							style={{ ...bodyInputStyle, minHeight: 104, resize: "vertical" }}
							placeholder="/review"
							value={action.body}
							onChange={(e) =>
								void updateAction(action.id, { body: e.target.value })
							}
						/>
					</Field>

					{derived.length > 0 && (
						<Field label="Asks for">
							<div className="flex flex-col gap-2.5">
								{derived.map((p) => (
									<ParameterEditor
										key={p.name}
										name={p.name}
										meta={p.meta}
										onChange={(patch) => setParam(p.name, patch)}
									/>
								))}
							</div>
						</Field>
					)}

					<Field label="Offered for">
						<ScopeEditor
							scope={action.scope}
							agents={agents.map((a) => ({ id: a.id, name: a.name }))}
							onChange={(scope) => void updateAction(action.id, { scope })}
						/>
					</Field>

					<ToggleRow
						checked={action.showInBar}
						onChange={(v) => void updateAction(action.id, { showInBar: v })}
						label="Show in the pane's action bar"
						description="Off keeps it in the command palette only — useful once the bar gets long."
					/>
				</div>
			)}
		</div>
	);
}

function IconButton({
	label,
	title,
	disabled = false,
	flip = false,
	icon,
	onClick,
}: {
	label: string;
	title: string;
	disabled?: boolean;
	flip?: boolean;
	icon?: React.ReactNode;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			aria-label={label}
			title={title}
			className="inline-flex items-center justify-center rounded-md transition-colors"
			style={{
				width: 26,
				height: 26,
				color: "var(--fg-secondary)",
				opacity: disabled ? 0.25 : 0.75,
				cursor: disabled ? "default" : "pointer",
				transform: flip ? "rotate(180deg)" : undefined,
			}}
			onClick={onClick}
		>
			{icon ?? <ChevronDown />}
		</button>
	);
}

/** Label over control. UI font, sentence case — mono is for the body and the
 *  parameter names, which are code; a form label is prose. */
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
						lineHeight: 1.45,
					}}
				>
					{hint}
				</span>
			)}
		</div>
	);
}

function ScopeEditor({
	scope,
	agents,
	onChange,
}: {
	scope: ActionScope;
	agents: { id: string; name: string }[];
	onChange: (s: ActionScope) => void;
}) {
	const selected = scope.kind === "set" ? scope.agentIds : [];

	return (
		<div className="flex flex-col gap-3">
			<select
				className="rounded-lg"
				style={{ ...selectStyle, height: 36, fontSize: 13, width: "100%" }}
				value={scope.kind}
				onChange={(e) =>
					onChange(
						e.target.value === "all"
							? { kind: "all" }
							: { kind: "set", agentIds: selected },
					)
				}
			>
				{/* `all` and a set naming every current agent are different values on
				    purpose: `all` picks up an agent added tomorrow, a set does not. */}
				<option value="all">All agents</option>
				<option value="set">Only the agents I pick…</option>
			</select>

			{scope.kind === "set" && (
				<div
					className="rounded-lg grid gap-x-5 gap-y-2.5"
					style={{
						padding: "12px 14px",
						gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
						backgroundColor: "var(--bg-primary)",
						border: "1px solid var(--border)",
					}}
				>
					{agents.map((a) => (
						<label
							key={a.id}
							className="flex items-center gap-2.5 cursor-pointer"
							style={{ fontSize: 12, color: "var(--fg-primary)" }}
						>
							<input
								type="checkbox"
								checked={selected.includes(a.id)}
								onChange={(e) =>
									onChange({
										kind: "set",
										agentIds: e.target.checked
											? [...selected, a.id]
											: selected.filter((x) => x !== a.id),
									})
								}
							/>
							<span className="truncate">{a.name}</span>
						</label>
					))}
				</div>
			)}

			{scope.kind === "set" && selected.length === 0 && (
				<span
					style={{
						fontSize: 11,
						color: "var(--warning, #d99a2b)",
						lineHeight: 1.45,
					}}
				>
					No agents selected — this action is kept, but never offered anywhere.
				</span>
			)}
		</div>
	);
}
