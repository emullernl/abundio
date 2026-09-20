/**
 * A text control that edits a **persisted** value without writing on every
 * keystroke.
 *
 * Settings edits Prompt actions in place, and the naive shape — `value` from
 * the store, `onChange` straight to `updateAction` — is broken three ways at
 * once:
 *
 * 1. **Every character is an IPC round-trip**, a broadcast to every Window and
 *    a full re-read of the list.
 * 2. **Characters are dropped.** The input is controlled off the store, so a
 *    keystroke typed while a write is in flight is overwritten when the reload
 *    resolves and re-renders with the older value.
 * 3. **You cannot clear the field.** Rust refuses a blank name, so select-all
 *    then type re-renders the old name back before the first character lands.
 *
 * So the draft lives here and is committed on blur, or on Enter for the
 * single-line variant. The draft re-seeds only when the incoming value differs
 * from what it already holds, so a reload triggered by someone else's edit
 * cannot reformat the text under the cursor mid-edit.
 */

import { useEffect, useRef, useState } from "react";

interface DraftInputProps {
	value: string;
	onCommit: (next: string) => void;
	multiline?: boolean;
	placeholder?: string;
	style?: React.CSSProperties;
	className?: string;
	rows?: number;
}

export function DraftInput({
	value,
	onCommit,
	multiline = false,
	placeholder,
	style,
	className,
}: DraftInputProps) {
	const [draft, setDraft] = useState(value);
	// What we last saw from, or sent to, the store. Lets us tell "the prop
	// changed because someone else edited it" from "the prop changed because our
	// own commit came back".
	const known = useRef(value);

	useEffect(() => {
		if (value === known.current) return;
		known.current = value;
		setDraft(value);
	}, [value]);

	function commit() {
		if (draft === known.current) return;
		known.current = draft;
		onCommit(draft);
	}

	const shared = {
		className,
		style,
		placeholder,
		value: draft,
		onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
			setDraft(e.target.value),
		onBlur: commit,
	};

	if (multiline) {
		// No Enter-to-commit: a prompt body is legitimately multi-line, so Enter
		// has to insert a newline.
		return <textarea {...shared} />;
	}

	return (
		<input
			{...shared}
			onKeyDown={(e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					commit();
					e.currentTarget.blur();
				}
				if (e.key === "Escape") {
					// Abandon the edit rather than committing half a word.
					setDraft(known.current);
					e.currentTarget.blur();
				}
			}}
		/>
	);
}
