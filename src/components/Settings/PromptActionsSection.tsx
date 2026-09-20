/**
 * Settings ▸ Prompt actions — the full editor.
 *
 * The larger of the two authoring surfaces. The in-pane popover covers "make a
 * button now"; everything structural lives here: scope across several Agents,
 * parameter defaults and choice options, **Show in bar**, reordering, deletion.
 *
 * Reordering matters more than it looks. A bar button's **position number** is
 * the digit that fires it, so dragging a row here moves a keyboard shortcut.
 */

import { useEffect, useMemo, useState } from "react";
import {
	type ActionScope,
	deriveParams,
	type ParamMeta,
	type ParamMetaMap,
	type ParamType,
	type PromptAction,
} from "../../lib/promptActions";
import { usePromptActionStore } from "../../stores/promptActionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { ChevronDown, ChevronRight, Plus, X } from "../Icons";
import { SectionLabel, Toggle } from "./primitives";

const PARAM_TYPES: ParamType[] = [
	"text",
	"number",
	"choice",
	"toggle",
	"attachment",
];

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
		const created = await createAction({
			name: "New action",
			body: "Describe what to send. Use {{value}} to ask for one.",
		});
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
		<div className="flex flex-col gap-5">
			<div>
				<SectionLabel>Prompt actions</SectionLabel>
				<p
					style={{
						fontSize: 12,
						color: "var(--fg-secondary)",
						lineHeight: 1.6,
						marginBottom: 14,
					}}
				>
					One-click prompts for a running agent, shown along the bottom of its
					pane. Order decides the keyboard shortcut — the first nine get{" "}
					<Shortcut n={1} /> to <Shortcut n={9} />.
				</p>

				{actions.length === 0 ? (
					<EmptyState onAdd={add} />
				) : (
					<div className="flex flex-col gap-2">
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
					className="self-start inline-flex items-center gap-1.5 rounded-md px-3 py-2 transition-colors"
					style={{
						fontSize: 12,
						color: "var(--fg-secondary)",
						border: "1px solid var(--border)",
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
				padding: "1px 5px",
				borderRadius: 4,
				border: "1px solid var(--border)",
				color: "var(--fg-primary)",
			}}
		>
			{label}
		</kbd>
	);
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
	return (
		<div
			className="rounded-xl px-5 py-6 flex flex-col items-start gap-3"
			style={{
				border: "1px dashed color-mix(in srgb, var(--border) 80%, transparent)",
			}}
		>
			<p
				style={{ fontSize: 12, color: "var(--fg-secondary)", lineHeight: 1.6 }}
			>
				Nothing yet. Abundio ships no built-in actions on purpose — a stock
				“/review” button would assume a slash command only some installs have,
				and fail on first click. Add your own, here or from the{" "}
				<code style={{ fontFamily: "var(--font-mono)" }}>⋯</code> menu in any
				agent pane.
			</p>
			<button
				type="button"
				className="inline-flex items-center gap-1.5 rounded-md px-3 py-2"
				style={{
					fontSize: 12,
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

	const scopeLabel =
		action.scope.kind === "all"
			? "All agents"
			: action.scope.agentIds.length === 0
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

	function setScope(scope: ActionScope) {
		void updateAction(action.id, { scope });
	}

	return (
		<div
			className="rounded-lg overflow-hidden"
			style={{
				border: "1px solid var(--border)",
				backgroundColor: "var(--bg-primary)",
			}}
		>
			<div className="flex items-center gap-2.5 px-3.5 py-2.5">
				<button
					type="button"
					aria-label={expanded ? "Collapse" : "Expand"}
					style={{ color: "var(--fg-secondary)" }}
					onClick={onToggle}
				>
					{expanded ? <ChevronDown /> : <ChevronRight />}
				</button>

				{/* Only the first nine have a digit; past that the slot is blank
				    rather than showing a number nothing will fire. */}
				<span
					className="tabular-nums shrink-0"
					style={{
						fontFamily: "var(--font-mono)",
						fontSize: 11,
						width: 14,
						color: "var(--fg-secondary)",
						opacity: action.showInBar && slot <= 9 ? 0.7 : 0.25,
					}}
				>
					{action.showInBar && slot <= 9 ? slot : "·"}
				</span>

				<span
					className="truncate"
					style={{ fontSize: 13, color: "var(--fg-primary)" }}
				>
					{action.name}
				</span>

				<span
					className="truncate ml-auto shrink-0"
					style={{
						fontSize: 11,
						color:
							action.scope.kind === "set" && action.scope.agentIds.length === 0
								? "var(--warning, #d99a2b)"
								: "var(--fg-secondary)",
						maxWidth: 180,
					}}
					title={scopeLabel}
				>
					{scopeLabel}
				</span>

				<div className="flex items-center gap-1 shrink-0">
					<MoveButton
						dir="up"
						disabled={!canMoveUp}
						onClick={() => onMove(-1)}
					/>
					<MoveButton
						dir="down"
						disabled={!canMoveDown}
						onClick={() => onMove(1)}
					/>
					<button
						type="button"
						aria-label={`Delete ${action.name}`}
						style={{ color: "var(--fg-secondary)", opacity: 0.6 }}
						onClick={() => void deleteAction(action.id)}
					>
						<X />
					</button>
				</div>
			</div>

			{expanded && (
				<div
					className="flex flex-col gap-4 px-3.5 pb-4 pt-3.5"
					style={{ borderTop: "1px solid var(--border)" }}
				>
					<Labelled label="Name">
						<input
							className="rounded-md px-2.5 py-2"
							style={inputStyle}
							value={action.name}
							onChange={(e) =>
								void updateAction(action.id, { name: e.target.value })
							}
						/>
					</Labelled>

					<Labelled label="Sends">
						<textarea
							className="rounded-md px-2.5 py-2"
							style={{ ...inputStyle, resize: "vertical" }}
							rows={4}
							value={action.body}
							onChange={(e) =>
								void updateAction(action.id, { body: e.target.value })
							}
						/>
					</Labelled>

					{derived.length > 0 && (
						<Labelled label="Asks for">
							<div className="flex flex-col gap-2">
								{derived.map((p) => (
									<ParamEditor
										key={p.name}
										name={p.name}
										meta={p.meta}
										onChange={(patch) => setParam(p.name, patch)}
									/>
								))}
							</div>
						</Labelled>
					)}

					<Labelled label="Offered for">
						<ScopeEditor
							scope={action.scope}
							agents={agents.map((a) => ({ id: a.id, name: a.name }))}
							onChange={setScope}
						/>
					</Labelled>

					{/* Not a <label>: Toggle is a custom control, so there is nothing
					    for htmlFor to point at. */}
					<div className="flex items-center justify-between gap-3">
						<span style={{ fontSize: 12, color: "var(--fg-primary)" }}>
							Show in the pane's action bar
							<span
								className="block"
								style={{ fontSize: 11, color: "var(--fg-secondary)" }}
							>
								Off keeps it in the command palette only — useful once the bar
								gets long.
							</span>
						</span>
						<Toggle
							checked={action.showInBar}
							onChange={(v) => void updateAction(action.id, { showInBar: v })}
						/>
					</div>
				</div>
			)}
		</div>
	);
}

function MoveButton({
	dir,
	disabled,
	onClick,
}: {
	dir: "up" | "down";
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			aria-label={`Move ${dir}`}
			title={`Move ${dir} — changes its keyboard shortcut`}
			style={{
				color: "var(--fg-secondary)",
				opacity: disabled ? 0.2 : 0.6,
				cursor: disabled ? "default" : "pointer",
				transform: dir === "up" ? "rotate(180deg)" : undefined,
				lineHeight: 0,
			}}
			onClick={onClick}
		>
			<ChevronDown />
		</button>
	);
}

function ParamEditor({
	name,
	meta,
	onChange,
}: {
	name: string;
	meta: ParamMeta;
	onChange: (patch: Partial<ParamMeta>) => void;
}) {
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<span
					className="truncate"
					style={{
						fontFamily: "var(--font-mono)",
						fontSize: 11,
						color: "var(--fg-primary)",
						minWidth: 100,
					}}
				>
					{name}
				</span>
				<select
					className="rounded-md px-2.5 py-1.5"
					style={{ ...inputStyle, fontSize: 11, width: 120 }}
					value={meta.type}
					onChange={(e) => onChange({ type: e.target.value as ParamType })}
				>
					{PARAM_TYPES.map((t) => (
						<option key={t} value={t}>
							{t}
						</option>
					))}
				</select>

				{meta.type !== "attachment" && meta.type !== "toggle" && (
					<input
						className="rounded-md px-2.5 py-1.5 flex-1"
						style={{ ...inputStyle, fontSize: 11 }}
						placeholder="default"
						value={meta.defaultValue ?? ""}
						onChange={(e) => onChange({ defaultValue: e.target.value })}
					/>
				)}
			</div>

			{meta.type === "choice" && (
				<input
					className="rounded-md px-2.5 py-1.5"
					style={{ ...inputStyle, fontSize: 11 }}
					placeholder="Options, comma separated"
					value={(meta.options ?? []).join(", ")}
					onChange={(e) =>
						onChange({
							options: e.target.value
								.split(",")
								.map((o) => o.trim())
								.filter(Boolean),
						})
					}
				/>
			)}

			{/* A toggle contributes author-written text, never `true`/`false` — a
			    literal boolean in a prompt says nothing an agent can act on. */}
			{meta.type === "toggle" && (
				<div className="flex items-center gap-2">
					<input
						className="rounded-md px-2.5 py-1.5 flex-1"
						style={{ ...inputStyle, fontSize: 11 }}
						placeholder="text when on"
						value={meta.onText ?? ""}
						onChange={(e) => onChange({ onText: e.target.value })}
					/>
					<input
						className="rounded-md px-2.5 py-1.5 flex-1"
						style={{ ...inputStyle, fontSize: 11 }}
						placeholder="text when off"
						value={meta.offText ?? ""}
						onChange={(e) => onChange({ offText: e.target.value })}
					/>
				</div>
			)}

			{meta.type === "attachment" && (
				<label
					className="flex items-center gap-2"
					style={{ fontSize: 11, color: "var(--fg-secondary)" }}
				>
					<input
						type="checkbox"
						checked={meta.multiple ?? false}
						onChange={(e) => onChange({ multiple: e.target.checked })}
					/>
					Allow several files
				</label>
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
		<div className="flex flex-col gap-2">
			<select
				className="rounded-md px-2.5 py-2"
				style={{ ...inputStyle, fontSize: 12 }}
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
				<option value="set">Selected agents…</option>
			</select>

			{scope.kind === "set" && (
				<div className="flex flex-wrap gap-x-4 gap-y-1.5">
					{agents.map((a) => (
						<label
							key={a.id}
							className="flex items-center gap-1.5"
							style={{ fontSize: 11, color: "var(--fg-secondary)" }}
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
							{a.name}
						</label>
					))}
				</div>
			)}

			{scope.kind === "set" && selected.length === 0 && (
				<span style={{ fontSize: 11, color: "var(--warning, #d99a2b)" }}>
					No agents selected — this action is kept but never offered.
				</span>
			)}
		</div>
	);
}

function Labelled({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2">
			<span
				style={{
					fontFamily: "var(--font-mono)",
					fontSize: 10,
					color: "var(--fg-secondary)",
					opacity: 0.75,
					textTransform: "lowercase",
				}}
			>
				{label}
			</span>
			{children}
		</div>
	);
}

const inputStyle: React.CSSProperties = {
	fontFamily: "var(--font-mono)",
	fontSize: 12,
	color: "var(--fg-primary)",
	backgroundColor: "var(--bg-secondary)",
	border: "1px solid var(--border)",
	outline: "none",
	width: "100%",
};
