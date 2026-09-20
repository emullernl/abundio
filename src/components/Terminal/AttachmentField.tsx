/**
 * The **Attachment** parameter's field.
 *
 * Three ways in, and they differ in whether a path already exists:
 *
 * - **File picker** — Tauri's dialog returns real paths. Nothing is copied;
 *   the file stays where the user keeps it.
 * - **Cmd+V** — a paste yields bytes with no path, so it is written to a
 *   content-hashed file under the versioned root and *that* path is used.
 * - **Drag-drop of a pasted-looking image** is not handled here: OS file drops
 *   are delivered app-wide by Tauri and are already owned by
 *   `useTerminalFileDrop`, which targets panes. Intercepting them for a modal
 *   would fight that.
 *
 * The value is always **paths**, never bytes — see ADR-0038. Nothing here
 * touches the OS clipboard or synthesises a `Ctrl+V`.
 */

import { ImagePlus, Paperclip, X } from "lucide-react";
import { useState } from "react";
import { promptAttachments } from "../../lib/ipc";
import type { ParamValue } from "../../lib/promptActions";

interface AttachmentFieldProps {
	multiple: boolean;
	paths: string[];
	onChange: (v: ParamValue) => void;
}

/** Map a pasted image's MIME type to the extension Rust will accept. */
const MIME_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
	"image/tiff": "tiff",
};

function basename(p: string): string {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i >= 0 ? p.slice(i + 1) : p;
}

export function AttachmentField({
	multiple,
	paths,
	onChange,
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

	async function handlePaste(e: React.ClipboardEvent) {
		const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
			i.type.startsWith("image/"),
		);
		if (!item) return; // a text paste is not ours to intercept
		e.preventDefault();
		const file = item.getAsFile();
		if (!file) return;

		const ext = MIME_EXT[item.type];
		if (!ext) {
			setError(`Cannot attach a ${item.type} image`);
			return;
		}

		setBusy(true);
		setError(null);
		try {
			const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
			const path = await promptAttachments.save(bytes, ext);
			add([path]);
		} catch (err) {
			setError(String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-1.5">
			<div
				className="rounded-lg px-3 py-3 flex flex-col gap-2.5"
				style={{
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
								className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 max-w-full"
								style={{
									fontFamily: "var(--font-mono)",
									fontSize: 10,
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

				{/* The paste target is the button itself, not a tabIndex'd div: a
				    paste event goes to the focused element, and a button is
				    focusable and interactive without any a11y contortions. Clicking
				    it opens the picker, so the same control does both jobs. */}
				<button
					type="button"
					className="inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 self-start transition-colors"
					style={{
						fontSize: 11,
						color: "var(--fg-secondary)",
						border: "1px solid var(--border)",
					}}
					onPaste={handlePaste}
					onClick={pick}
				>
					<ImagePlus size={11} />
					{paths.length > 0 && !multiple ? "Replace…" : "Choose file…"}
					<span
						style={{
							fontFamily: "var(--font-mono)",
							fontSize: 10,
							opacity: 0.6,
						}}
					>
						{busy ? "saving…" : "or ⌘V here"}
					</span>
				</button>
			</div>

			{error && (
				<span style={{ fontSize: 10, color: "var(--error)" }}>{error}</span>
			)}
		</div>
	);
}
