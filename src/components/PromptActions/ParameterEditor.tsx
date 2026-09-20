/**
 * The editor for one **Parameter** of a **Prompt action**, shared by both
 * authoring surfaces: the in-pane popover and Settings ▸ Prompt actions.
 *
 * Shared on purpose. The popover is deliberately the *smaller* editor —
 * reordering, duplication and deletion stay in Settings — but everything
 * needed to finish *defining a parameter* has to be in both, or the popover
 * can mint a `choice` with no options (an empty dropdown) or a `toggle` that
 * contributes nothing. Two copies of this form drifted once already; one
 * component is the repair.
 *
 * ## Type
 *
 * Monospace is reserved for the two things that really are code — the prompt
 * body, and a parameter **name**, which is the `{{token}}` inside it.
 * Everything else uses the UI font. See the note in PromptActionsSection.
 */

import { useEffect, useState } from "react";
import type { ParamMeta, ParamType } from "../../lib/promptActions";
import { DraftInput } from "./DraftInput";
import { paramSelectStyle, paramTextInputStyle } from "./fieldStyles";

export const PARAM_TYPES: ParamType[] = [
	"text",
	"number",
	"choice",
	"toggle",
	"attachment",
];

const PARAM_TYPE_HINT: Record<ParamType, string> = {
	text: "A line of text. Grows on Shift+Enter.",
	number: "Checked before sending.",
	choice: "One of a fixed list you define.",
	toggle: "Contributes wording you write, not “true”.",
	attachment: "A file. Its path goes into the prompt.",
};

interface ParameterEditorProps {
	name: string;
	meta: ParamMeta;
	onChange: (patch: Partial<ParamMeta>) => void;
	/** The popover is 460px wide and cannot afford the per-type hint line. */
	compact?: boolean;
}

export function ParameterEditor({
	name,
	meta,
	onChange,
	compact = false,
}: ParameterEditorProps) {
	const small = { ...paramTextInputStyle, height: 32, fontSize: 12 };

	return (
		<div
			className="rounded-lg flex flex-col gap-3"
			style={{
				padding: "12px 14px",
				backgroundColor: "var(--bg-primary)",
				border: "1px solid var(--border)",
			}}
		>
			<div className="flex items-center gap-3">
				{/* Mono, because this is the `{{token}}` as it appears in the body. */}
				<span
					className="truncate rounded-md"
					style={{
						padding: "0 8px",
						fontFamily: "var(--font-mono)",
						fontSize: 12,
						lineHeight: "22px",
						color: "var(--fg-primary)",
						backgroundColor:
							"color-mix(in srgb, var(--accent) 14%, transparent)",
					}}
				>
					{name}
				</span>
				<select
					className="rounded-md"
					style={{ ...paramSelectStyle, width: compact ? 116 : 138 }}
					value={meta.type}
					onChange={(e) => onChange({ type: e.target.value as ParamType })}
				>
					{PARAM_TYPES.map((t) => (
						<option key={t} value={t}>
							{t}
						</option>
					))}
				</select>
				{!compact && (
					<span
						className="truncate"
						style={{
							fontSize: 11,
							color: "var(--fg-secondary)",
							opacity: 0.75,
						}}
					>
						{PARAM_TYPE_HINT[meta.type]}
					</span>
				)}
			</div>

			{meta.type !== "attachment" && meta.type !== "toggle" && (
				<DraftInput
					className="rounded-md"
					style={small}
					placeholder="Default value (optional)"
					value={meta.defaultValue ?? ""}
					onCommit={(defaultValue) => onChange({ defaultValue })}
				/>
			)}

			{meta.type === "choice" && (
				<OptionsInput
					options={meta.options ?? []}
					onChange={(options) => onChange({ options })}
				/>
			)}

			{/* A toggle contributes author-written text, never `true`/`false` — a
			    literal boolean in a prompt says nothing an agent can act on. */}
			{meta.type === "toggle" && (
				<div
					className={
						compact ? "flex flex-col gap-2.5" : "flex items-center gap-2.5"
					}
				>
					<DraftInput
						className="rounded-md flex-1"
						style={small}
						placeholder="Text when on"
						value={meta.onText ?? ""}
						onCommit={(onText) => onChange({ onText })}
					/>
					<DraftInput
						className="rounded-md flex-1"
						style={small}
						placeholder="Text when off"
						value={meta.offText ?? ""}
						onCommit={(offText) => onChange({ offText })}
					/>
				</div>
			)}

			<div className="flex items-center gap-5">
				{/* A toggle has no required/optional question: both of its states are
				    meaningful and the author wrote text for each. */}
				{meta.type !== "toggle" && (
					<label
						className="flex items-center gap-2.5 cursor-pointer"
						style={{ fontSize: 12, color: "var(--fg-secondary)" }}
						title="Left empty, an optional value and the gap around it disappear from the prompt"
					>
						<input
							type="checkbox"
							checked={meta.required !== false}
							onChange={(e) => onChange({ required: e.target.checked })}
						/>
						Required
					</label>
				)}

				{meta.type === "attachment" && (
					<label
						className="flex items-center gap-2.5 cursor-pointer"
						style={{ fontSize: 12, color: "var(--fg-secondary)" }}
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
		</div>
	);
}

/**
 * The comma-separated options for a `choice` parameter.
 *
 * Holds the raw text locally and parses alongside it, rather than deriving the
 * displayed value from the parsed array. Round-tripping through
 * `split(",").filter(Boolean).join(", ")` on every keystroke deletes the comma
 * the moment it is typed — `low,` parses to `["low"]`, which renders back as
 * `low` — so the list could never be extended past its first entry.
 *
 * The draft re-seeds only when the incoming options differ from what it already
 * represents, so a parent re-render cannot reformat the text mid-edit.
 */
function OptionsInput({
	options,
	onChange,
}: {
	options: string[];
	onChange: (options: string[]) => void;
}) {
	const [draft, setDraft] = useState(() => options.join(", "));

	useEffect(() => {
		setDraft((current) =>
			parseOptions(current).join("\u0000") === options.join("\u0000")
				? current
				: options.join(", "),
		);
	}, [options]);

	return (
		<input
			className="rounded-md"
			style={{ ...paramTextInputStyle, height: 32, fontSize: 12 }}
			placeholder="Options, comma separated — low, medium, high"
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={() => {
				const parsed = parseOptions(draft);
				setDraft(parsed.join(", "));
				onChange(parsed);
			}}
		/>
	);
}

/** Trailing and empty entries are dropped, so a half-typed `low, ` yields one
 *  option while the text still shows the comma the user just pressed. */
function parseOptions(raw: string): string[] {
	return raw
		.split(",")
		.map((o) => o.trim())
		.filter(Boolean);
}
