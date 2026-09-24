/**
 * Collects a **Prompt action**'s **Parameters** before it fires.
 *
 * Opens for any action with one or more Parameters; an action with none never
 * reaches here. One rule, one UI — an inline-in-the-bar variant for the
 * single-parameter case was considered and rejected: the bar is a 24px
 * horizontally-scrolling rail, a field there could not grow on Shift+Enter, and
 * an `attachment` could not render in it at all.
 *
 * Every field is **required** and Send stays disabled until all are filled.
 * Fields are pre-filled from authored defaults only — never from the last value
 * used, because Enter submits this dialog and firing submits to the Agent, so a
 * reflex Enter would send a three-day-old value nobody read.
 *
 * Visually a continuation of the pane's own chrome rather than a web modal:
 * mono type, the same hairline borders, and a single accent stripe naming the
 * action so it is obvious which button is about to speak.
 */

import { AnimatePresence, motion } from "framer-motion";
import { CornerDownLeft } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { isMac } from "../../lib/platform";
import {
	allFilled,
	deriveParams,
	initialValues,
	isFilled,
	isRequired,
	type ParamMeta,
	type ParamValue,
	type PromptAction,
	resolveBody,
} from "../../lib/promptActions";
import {
	primaryButtonClass,
	secondaryButtonClass,
} from "../PromptActions/fieldStyles";
import { Select } from "../PromptActions/Select";
import { AttachmentField } from "./AttachmentField";

interface ParameterDialogProps {
	action: PromptAction;
	/** Returns the refusal reason to show, or null when the send went out. The
	 *  dialog stays open on a refusal — closing it would be indistinguishable
	 *  from a successful send, and firing normally submits. */
	onSubmit: (
		values: Record<string, ParamValue>,
		stageOnly: boolean,
	) => string | null;
	onCancel: () => void;
}

export function ParameterDialog({
	action,
	onSubmit,
	onCancel,
}: ParameterDialogProps) {
	const params = useMemo(
		() => deriveParams(action.body, action.params),
		[action.body, action.params],
	);
	const [values, setValues] = useState<Record<string, ParamValue>>(() =>
		initialValues(action.body, action.params),
	);
	const firstRef = useRef<HTMLElement>(null);

	useEscapeKey(onCancel);

	useEffect(() => {
		const el = firstRef.current;
		el?.focus();
		// Select the authored default so typing replaces it rather than appending
		// to it. Guarded because the first field may be a toggle or an
		// attachment, neither of which is a text input.
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
			el.select();
	}, []);

	const ready = allFilled(action.body, action.params, values);

	function setValue(name: string, value: ParamValue) {
		setValues((v) => ({ ...v, [name]: value }));
	}

	const [refusal, setRefusal] = useState<string | null>(null);

	function submit(stageOnly: boolean) {
		if (!ready) return;
		setRefusal(onSubmit(values, stageOnly));
	}

	return (
		<AnimatePresence>
			<motion.div
				role="presentation"
				className="fixed inset-0 z-[200] flex items-center justify-center"
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				exit={{ opacity: 0 }}
				transition={{ duration: 0.15 }}
				style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
				onClick={onCancel}
				onKeyDown={(e) => e.key === "Escape" && onCancel()}
			>
				<motion.div
					role="dialog"
					aria-label={`Parameters for ${action.name}`}
					className="rounded-2xl overflow-hidden flex flex-col"
					initial={{ opacity: 0, scale: 0.97, y: 8 }}
					animate={{ opacity: 1, scale: 1, y: 0 }}
					exit={{ opacity: 0, scale: 0.97, y: 8 }}
					transition={{ duration: 0.15, ease: [0.2, 0, 0, 1] }}
					style={{
						width: 520,
						maxHeight: "82vh",
						backgroundColor: "var(--bg-secondary)",
						border: "1px solid var(--border)",
						boxShadow:
							"0 25px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset",
					}}
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
				>
					{/* The accent stripe names which button is about to speak. */}
					<header
						style={{
							padding: "16px 24px",
							borderBottom: "1px solid var(--border)",
							borderLeft: "2px solid var(--accent)",
						}}
					>
						<h2 style={{ fontSize: 14, color: "var(--fg-primary)" }}>
							{action.name}
						</h2>
						<p
							style={{
								fontSize: 12,
								color: "var(--fg-secondary)",
								marginTop: 3,
							}}
						>
							{params.length === 1
								? "Fill this in, then send it to the agent."
								: `Fill these ${params.length} in, then send them to the agent.`}
						</p>
					</header>

					<div
						className="flex flex-col gap-5 overflow-y-auto"
						style={{ padding: "20px 24px" }}
					>
						{params.map((p, i) => (
							<Field
								key={p.name}
								name={p.name}
								meta={p.meta}
								value={values[p.name]}
								inputRef={i === 0 ? firstRef : undefined}
								onChange={(v) => setValue(p.name, v)}
								onSubmit={() => submit(false)}
							/>
						))}

						<BodyPreview action={action} values={values} />
					</div>

					<div
						className="flex items-center justify-between gap-4"
						style={{
							padding: "16px 24px",
							borderTop: "1px solid var(--border)",
						}}
					>
						{refusal ? (
							<span
								style={{
									fontSize: 11,
									color: "var(--warning, #d99a2b)",
									lineHeight: 1.4,
								}}
							>
								{refusal}
							</span>
						) : (
							<span
								style={{
									fontSize: 11,
									color: "var(--fg-secondary)",
									opacity: 0.8,
								}}
							>
								Hold {isMac ? "⌥" : "Alt"} to stage without sending
							</span>
						)}
						<div className="flex items-center gap-2">
							<button
								type="button"
								className={`${secondaryButtonClass} rounded-lg`}
								style={{
									padding: "0 14px",
									height: 34,
									fontSize: 13,
								}}
								onClick={onCancel}
							>
								Cancel
							</button>
							<button
								type="button"
								disabled={!ready}
								className={`${primaryButtonClass} rounded-lg`}
								style={{
									padding: "0 16px",
									height: 34,
									fontSize: 13,
									fontWeight: 500,
									backgroundColor: "var(--accent)",
									color: "var(--bg-primary)",
									opacity: ready ? 1 : 0.35,
								}}
								title={
									ready
										? "Send to the agent"
										: "Fill every field first — they are all required"
								}
								onClick={(e) => submit(e.altKey)}
							>
								Send
								<CornerDownLeft size={12} />
							</button>
						</div>
					</div>
				</motion.div>
			</motion.div>
		</AnimatePresence>
	);
}

interface FieldProps {
	name: string;
	meta: ParamMeta;
	value: ParamValue;
	// biome-ignore lint/suspicious/noExplicitAny: one ref shared across input kinds
	inputRef?: React.RefObject<any>;
	onChange: (v: ParamValue) => void;
	onSubmit: () => void;
}

function Field({
	name,
	meta,
	value,
	inputRef,
	onChange,
	onSubmit,
}: FieldProps) {
	const required = isRequired(meta);
	const filled = isFilled(meta, value);

	return (
		/* Not a <label>: the toggle, choice and attachment controls are custom
		   elements with nothing for htmlFor to point at. Each control names
		   itself with aria-label instead. */
		<div className="flex flex-col gap-2">
			<span className="flex items-baseline gap-2.5">
				{/* The parameter's own name, in mono because it IS the {{token}} the
				    body carries. The "required" tag beside it is prose. */}
				<span
					style={{
						fontFamily: "var(--font-mono)",
						fontSize: 12,
						color: "var(--fg-primary)",
					}}
				>
					{name}
				</span>
				{required ? (
					!filled && (
						<span
							style={{ fontSize: 11, color: "var(--accent)", opacity: 0.9 }}
						>
							required
						</span>
					)
				) : (
					<span
						style={{ fontSize: 11, color: "var(--fg-secondary)", opacity: 0.7 }}
						title="Leave it empty and it drops out of the prompt entirely"
					>
						optional
					</span>
				)}
			</span>

			{meta.type === "toggle" ? (
				<ToggleField meta={meta} value={value === true} onChange={onChange} />
			) : meta.type === "choice" ? (
				<Select
					className="rounded-lg"
					style={fieldStyle}
					width="100%"
					aria-label={name}
					value={String(value ?? "")}
					options={(meta.options ?? []).map((o) => ({ value: o, label: o }))}
					onChange={onChange}
				/>
			) : meta.type === "attachment" ? (
				<AttachmentField
					multiple={meta.multiple ?? false}
					paths={Array.isArray(value) ? value : []}
					onChange={onChange}
				/>
			) : (
				<GrowingTextField
					name={name}
					inputRef={inputRef}
					numeric={meta.type === "number"}
					value={String(value ?? "")}
					onChange={onChange}
					onSubmit={onSubmit}
				/>
			)}
		</div>
	);
}

const fieldStyle: React.CSSProperties = {
	// The UI font at 13px: a value the user types is prose, and mono at the
	// same nominal size reads much denser. Only the prompt body itself, and the
	// parameter names that are `{{tokens}}` in it, stay monospaced.
	fontSize: 13,
	color: "var(--fg-primary)",
	backgroundColor: "var(--bg-primary)",
	border: "1px solid var(--border)",
	outline: "none",
	width: "100%",
	resize: "none",
	lineHeight: 1.5,
	// Inline, because every `p-*` utility in this app is dead: globals.css:273
	// has an unlayered `* { padding: 0 }` reset, and an unlayered normal
	// declaration beats a layered one whatever its specificity. See the note in
	// SettingsPanel.tsx.
	padding: "9px 12px",
};

/**
 * One line by default; **Shift+Enter grows it** by inserting a newline. Enter
 * submits the dialog. Mirrors what a chat input does, and what the Agents on
 * the other end do.
 */
function GrowingTextField({
	name,
	inputRef,
	numeric,
	value,
	onChange,
	onSubmit,
}: {
	name: string;
	// biome-ignore lint/suspicious/noExplicitAny: shared across input/textarea
	inputRef?: React.RefObject<any>;
	numeric: boolean;
	value: string;
	onChange: (v: string) => void;
	onSubmit: () => void;
}) {
	function handleKeyDown(
		e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
	) {
		if (e.key !== "Enter") return;
		// An IME commits its candidate with Enter. That keydown carries
		// isComposing (keyCode 229 on WebKit) and must not submit — it is the
		// user finishing a word, not firing the action.
		if (e.nativeEvent.isComposing || e.keyCode === 229) return;
		// Shift+Enter falls through to the textarea's own newline. A number
		// field cannot hold one, so there it is simply swallowed.
		if (e.shiftKey) {
			if (numeric) e.preventDefault();
			return;
		}
		e.preventDefault();
		onSubmit();
	}

	if (numeric) {
		return (
			<input
				ref={inputRef}
				type="number"
				aria-label={name}
				className="rounded-lg"
				style={fieldStyle}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={handleKeyDown}
			/>
		);
	}

	// Always a textarea, even at one row. Swapping an <input> for a <textarea>
	// on the first newline remounts the element, and the new one never had
	// focus — the caret vanished mid-sentence. `wrap="off"` keeps the one-row
	// state reading like an input: a long line scrolls sideways, not down.
	// `overflowX: hidden` hides the scrollbar that would otherwise appear:
	// on Windows and Linux it is ~16px of real space and would cover the one
	// row. The caret still scrolls the text. On blur the one-row state goes
	// back to the start, as an <input> does; a textarea would keep the tail.
	const multiline = value.includes("\n");
	const rows = Math.min(8, Math.max(1, value.split("\n").length));
	return (
		<textarea
			ref={inputRef}
			aria-label={name}
			className="rounded-lg"
			style={multiline ? fieldStyle : { ...fieldStyle, overflowX: "hidden" }}
			rows={rows}
			wrap={multiline ? "soft" : "off"}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			onKeyDown={handleKeyDown}
			onBlur={(e) => {
				if (!multiline) e.currentTarget.scrollLeft = 0;
			}}
		/>
	);
}

/**
 * A toggle contributes the author's own text, so the dialog shows that text
 * rather than a bare on/off — the user needs to see what the switch will
 * actually add to the prompt.
 */
function ToggleField({
	meta,
	value,
	onChange,
}: {
	meta: ParamMeta;
	value: boolean;
	onChange: (v: boolean) => void;
}) {
	const contributes = value ? meta.onText : meta.offText;
	return (
		<button
			type="button"
			className="flex items-center gap-3 rounded-lg text-left"
			style={{ ...fieldStyle, cursor: "pointer" }}
			onClick={() => onChange(!value)}
		>
			<span
				className="shrink-0 rounded-full transition-colors"
				style={{
					width: 26,
					height: 15,
					padding: 2,
					backgroundColor: value
						? "var(--accent)"
						: "color-mix(in srgb, var(--fg-secondary) 30%, transparent)",
				}}
			>
				<span
					className="block rounded-full transition-transform"
					style={{
						width: 11,
						height: 11,
						backgroundColor: "var(--bg-primary)",
						transform: value ? "translateX(11px)" : "none",
					}}
				/>
			</span>
			<span
				className="truncate"
				style={{
					fontSize: 11,
					color: contributes ? "var(--fg-primary)" : "var(--fg-secondary)",
					opacity: contributes ? 1 : 0.5,
				}}
			>
				{contributes || "adds nothing"}
			</span>
		</button>
	);
}

/** What will actually be sent. Worth the space: a click from here submits. */
function BodyPreview({
	action,
	values,
}: {
	action: PromptAction;
	values: Record<string, ParamValue>;
}) {
	const resolved = resolveBody(action.body, action.params, values);
	return (
		<div className="flex flex-col gap-2">
			<span style={{ fontSize: 12, color: "var(--fg-primary)", opacity: 0.85 }}>
				Will send
			</span>
			<pre
				className="rounded-lg overflow-auto whitespace-pre-wrap break-words"
				style={{
					padding: "10px 12px",
					fontFamily: "var(--font-mono)",
					fontSize: 11,
					lineHeight: 1.5,
					maxHeight: 140,
					color: "var(--fg-secondary)",
					backgroundColor:
						"color-mix(in srgb, var(--fg-primary) 4%, transparent)",
					border:
						"1px solid color-mix(in srgb, var(--border) 50%, transparent)",
				}}
			>
				{resolved}
			</pre>
		</div>
	);
}
