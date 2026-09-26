/**
 * The **Attachment** parameter's field.
 *
 * Three ways in, and they differ in whether a path already exists:
 *
 * - **File picker** — Tauri's dialog returns real paths. Nothing is copied;
 *   the file stays where the user keeps it.
 * - **Paste from clipboard** — a button, not Cmd+V. Rust reads the OS clipboard: files
 *   copied in Finder/Explorer attach by their own paths; otherwise the image
 *   is written to a content-hashed PNG under the versioned root and *that*
 *   path is used. A keyboard paste cannot work here: WebKit only fires `paste` on an
 *   editable element, so on macOS Cmd+V on a button never arrived at all.
 * - **Drag-drop of a pasted-looking image** is not handled here: OS file drops
 *   are delivered app-wide by Tauri and are already owned by
 *   `useTerminalFileDrop`, which targets panes. Intercepting them for a modal
 *   would fight that.
 *
 * The value is always **paths**, never bytes — see ADR-0038. The clipboard is
 * only ever read, never written, and no `Ctrl+V` is synthesised.
 */

import { ClipboardPaste, ImagePlus, Paperclip, X } from "lucide-react";
import { useState } from "react";
import { promptAttachments } from "../../lib/ipc";
import type { ParamValue } from "../../lib/promptActions";
import { secondaryButtonClass } from "../PromptActions/fieldStyles";

interface AttachmentFieldProps {
	multiple: boolean;
	paths: string[];
	onChange: (v: ParamValue) => void;
	/** The "Choose file…" button, which the dialog focuses when Enter is pressed
	 *  while this field is still empty. */
	chooseRef?: React.Ref<HTMLButtonElement>;
}

const buttonStyle: React.CSSProperties = {
	padding: "0 12px",
	height: 32,
	fontSize: 12,
};

const buttonClass = `${secondaryButtonClass} rounded-md`;

function basename(p: string): string {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i >= 0 ? p.slice(i + 1) : p;
}

export function AttachmentField({
	multiple,
	paths,
	onChange,
	chooseRef,
}: AttachmentFieldProps) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function add(next: string[]) {
		const merged = multiple ? [...paths, ...next] : next.slice(0, 1);
		// De-duplicate: attaching the same file twice says nothing extra, and a
		// content-hashed paste of the same image produces the same path.
		onChange([...new Set(merged)]);
	}

	async function pick() {
		setError(null);
		try {
			// Dynamic import, matching NewWorkspaceDialog and EnvImportDialog: the
			// plugin has no Tauri to reach in `pnpm demo:web`, so it must not be
			// pulled in until a click actually asks for a picker.
			const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
			const picked = await openDialog({ multiple, directory: false });
			if (!picked) return;
			add(Array.isArray(picked) ? picked : [picked]);
		} catch (e) {
			setError(String(e));
		}
	}

	async function pasteImage() {
		setBusy(true);
		setError(null);
		try {
			const pasted = await promptAttachments.fromClipboard();
			if (pasted.length > 0) add(pasted);
			else setError("There is no image or file on the clipboard");
		} catch (err) {
			setError(String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-1.5">
			<div
				className="rounded-lg flex flex-col gap-2.5"
				style={{
					padding: 12,
					backgroundColor: "var(--bg-primary)",
					border:
						"1px dashed color-mix(in srgb, var(--border) 80%, transparent)",
				}}
			>
				{paths.length > 0 && (
					<div className="flex flex-wrap gap-1.5">
						{paths.map((p) => (
							<span
								key={p}
								className="inline-flex items-center gap-1.5 rounded-md max-w-full"
								style={{
									padding: "5px 8px",
									fontFamily: "var(--font-mono)",
									fontSize: 11,
									color: "var(--fg-primary)",
									backgroundColor:
										"color-mix(in srgb, var(--accent) 14%, transparent)",
								}}
								title={p}
							>
								<Paperclip size={10} className="shrink-0" />
								<span className="truncate">{basename(p)}</span>
								<button
									type="button"
									aria-label={`Remove ${basename(p)}`}
									style={{ color: "var(--fg-secondary)" }}
									onClick={() => onChange(paths.filter((x) => x !== p))}
								>
									<X size={10} />
								</button>
							</span>
						))}
					</div>
				)}

				<div className="flex flex-wrap gap-2">
					<button
						ref={chooseRef}
						type="button"
						className={buttonClass}
						style={buttonStyle}
						onClick={pick}
						disabled={busy}
					>
						<ImagePlus size={11} />
						{paths.length > 0 && !multiple ? "Replace…" : "Choose file…"}
					</button>
					<button
						type="button"
						className={buttonClass}
						style={buttonStyle}
						onClick={pasteImage}
						disabled={busy}
					>
						<ClipboardPaste size={11} />
						{busy ? "Pasting…" : "Paste from clipboard"}
					</button>
				</div>
			</div>

			{error && (
				<span style={{ fontSize: 10, color: "var(--error)" }}>{error}</span>
			)}
		</div>
	);
}
