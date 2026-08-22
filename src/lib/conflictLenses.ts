/**
 * Monaco decorations and code lenses for git conflict blocks.
 *
 * Rendering is derived from the *text* — any buffer containing markers gets the
 * highlighting, whether or not it is unmerged. Whether the file can be *staged*
 * is a separate question answered by the index, not here. See ADR-0029.
 *
 * Never import from `monaco-editor/esm/vs/...`: this repo has no
 * `loader.config({ monaco })`, so `@monaco-editor/react` fetches monaco at
 * runtime and a deep import would bundle a second copy with a different model
 * registry and `Emitter` class. Only the `Monaco` handed to `onMount` is safe.
 */
import type { Monaco } from "@monaco-editor/react";
import type { editor, IDisposable, languages } from "monaco-editor";
import type {
	ConflictBlock,
	ResolveChoice,
	SideRange,
} from "./conflictMarkers";
import { resolveBlock } from "./conflictMarkers";

interface Registered {
	blocks: ConflictBlock[];
	/** Per-editor command id, from `ed.addCommand`. */
	commandId: string;
}

/** Keyed by `model.uri.toString()` — the provider is global, so this is what
 *  scopes it to the handful of models that actually have conflicts. */
const byUri = new Map<string, Registered>();

let registered = false;
let fireChange: (() => void) | null = null;

/**
 * Register the global code lens provider, once per process.
 *
 * Monaco has no per-model registration, so the provider is registered for all
 * languages (`"*"` — per-language would miss unknown extensions) and scopes
 * itself with one Map lookup per call. The `onDidChange` emitter is essential:
 * without it Monaco caches the lenses and they go stale the moment a block is
 * resolved.
 */
export function ensureConflictLensProvider(m: Monaco): void {
	if (registered) return;
	registered = true;

	// biome-ignore lint/suspicious/noExplicitAny: Emitter is runtime-only on Monaco
	const emitter = new (m as any).Emitter();
	fireChange = () => emitter.fire(provider);

	const provider: languages.CodeLensProvider = {
		onDidChange: emitter.event,
		provideCodeLenses(model) {
			const entry = byUri.get(model.uri.toString());
			if (!entry || entry.blocks.length === 0) {
				return { lenses: [], dispose() {} };
			}
			const lenses: languages.CodeLens[] = [];
			for (const block of entry.blocks) {
				const range = {
					startLineNumber: block.startLine,
					startColumn: 1,
					endLineNumber: block.startLine,
					endColumn: 1,
				};
				const lens = (title: string, choice: ResolveChoice) => ({
					range,
					command: {
						id: entry.commandId,
						title,
						arguments: [block.index, choice],
					},
				});
				lenses.push(lens("Accept Current", "current"));
				lenses.push(lens("Accept Incoming", "incoming"));
				lenses.push(lens("Accept Both", "both"));
				if (block.base) lenses.push(lens("Accept Base", "base"));
			}
			return { lenses, dispose() {} };
		},
		resolveCodeLens: (_model, lens) => lens,
	};

	m.languages.registerCodeLensProvider("*", provider);
}

/** Publish the blocks for one model and invalidate Monaco's lens cache. */
export function setConflictBlocks(
	uri: string,
	blocks: ConflictBlock[],
	commandId: string,
): void {
	byUri.set(uri, { blocks, commandId });
	fireChange?.();
}

export function clearConflictBlocks(uri: string): void {
	if (byUri.delete(uri)) fireChange?.();
}

/** Whole-line decorations for every side and marker line of every block. */
export function conflictDecorations(
	blocks: ConflictBlock[],
	activeIndex: number | null = null,
): editor.IModelDeltaDecoration[] {
	const out: editor.IModelDeltaDecoration[] = [];
	const wholeLines = (from: number, to: number, className: string) => {
		if (to < from) return;
		out.push({
			range: {
				startLineNumber: from,
				startColumn: 1,
				endLineNumber: to,
				endColumn: 1,
			},
			options: { isWholeLine: true, className },
		});
	};
	const markerLine = (line: number) =>
		out.push({
			range: {
				startLineNumber: line,
				startColumn: 1,
				endLineNumber: line,
				endColumn: 1,
			},
			options: {
				isWholeLine: true,
				className: "abundio-conflict-marker",
				glyphMarginClassName: "abundio-conflict-glyph",
			},
		});

	for (const b of blocks) {
		if (b.index === activeIndex) {
			// A gutter rail rather than another tint — the sides already own the
			// background colours here.
			out.push({
				range: {
					startLineNumber: b.startLine,
					startColumn: 1,
					endLineNumber: b.endLine,
					endColumn: 1,
				},
				options: {
					isWholeLine: true,
					linesDecorationsClassName: "abundio-conflict-active-rail",
				},
			});
		}
		markerLine(b.startLine);
		markerLine(b.endLine);
		wholeLines(
			b.current.startLine,
			b.current.endLine,
			"abundio-conflict-current",
		);
		if (b.base) {
			// The `|||||||` line itself, then the ancestor region.
			markerLine(b.base.startLine - 1);
			wholeLines(b.base.startLine, b.base.endLine, "abundio-conflict-base");
		}
		// The `=======` separator sits directly above the incoming side.
		markerLine(b.incoming.startLine - 1);
		wholeLines(
			b.incoming.startLine,
			b.incoming.endLine,
			"abundio-conflict-incoming",
		);
	}
	return out;
}

/**
 * Decorations for a **Merge side pane**: every conflict region marked, the
 * active one emphasised, and everything else dimmed.
 *
 * Dimming is what makes the region unmistakable — a read-only stage pane exists
 * to show you one place, so the rest of the file should read as context. It
 * costs at most N+1 decorations because the gaps *between* regions are spanned
 * whole, not decorated line by line.
 */
export function sideDecorations(
	ranges: (SideRange | null)[],
	activeIndex: number | null,
	lineCount: number,
	side: "current" | "incoming" | "base",
): editor.IModelDeltaDecoration[] {
	const out: editor.IModelDeltaDecoration[] = [];
	const sideClass = `abundio-side-${side}`;
	const whole = (
		from: number,
		to: number,
		options: editor.IModelDecorationOptions,
	) =>
		out.push({
			range: {
				startLineNumber: from,
				startColumn: 1,
				endLineNumber: to,
				endColumn: 1,
			},
			options,
		});

	// Gaps first, so a region's own background paints over the dim layer.
	let cursor = 1;
	const present = ranges
		.filter((r): r is SideRange => r !== null && r.endLine >= r.startLine)
		.sort((a, b) => a.startLine - b.startLine);
	for (const r of present) {
		if (r.startLine > cursor) {
			whole(cursor, r.startLine - 1, {
				isWholeLine: true,
				className: "abundio-side-dim",
			});
		}
		cursor = Math.max(cursor, r.endLine + 1);
	}
	if (cursor <= lineCount) {
		whole(cursor, lineCount, {
			isWholeLine: true,
			className: "abundio-side-dim",
		});
	}

	ranges.forEach((range, index) => {
		if (!range) return;
		const active = index === activeIndex;
		const state = active ? " abundio-side-active" : "";

		if (range.endLine < range.startLine) {
			// This side contributes nothing to the block. Mark the seam so the pane
			// reads as "deliberately empty here" rather than as a failed lookup.
			const line = Math.min(
				Math.max(range.startLine, 1),
				Math.max(lineCount, 1),
			);
			whole(line, line, {
				isWholeLine: true,
				className: `abundio-side-empty${state}`,
				linesDecorationsClassName: `abundio-side-rail ${sideClass}${state}`,
			});
			return;
		}

		whole(range.startLine, range.endLine, {
			isWholeLine: true,
			className: `abundio-side-hit ${sideClass}${state}`,
			linesDecorationsClassName: `abundio-side-rail ${sideClass}${state}`,
		});

		if (active) {
			// Hard boundaries: the extent of the active block must be unambiguous.
			whole(range.startLine, range.startLine, {
				isWholeLine: true,
				className: "abundio-side-edge-top",
			});
			whole(range.endLine, range.endLine, {
				isWholeLine: true,
				className: "abundio-side-edge-bottom",
			});
		}
	});

	return out;
}

/**
 * Replace one conflict block with the chosen side, through the editor.
 *
 * Deliberately `executeEdits` rather than writing a new `value`: the controlled
 * `value` prop reconciles a mismatch with `model.setValue()`, which destroys the
 * undo stack and the cursor. Going through the editor keeps Cmd+Z working, and
 * the resulting `onChange` propagates to the store on its own.
 */
export function applyChoice(
	ed: editor.IStandaloneCodeEditor,
	blocks: ConflictBlock[],
	blockIndex: number,
	choice: ResolveChoice,
): void {
	const model = ed.getModel();
	const block = blocks[blockIndex];
	if (!model || !block) return;

	const text = model.getValue();
	const resolved = resolveBlock(text, block, choice);
	// The splice is contiguous, so the edit is exactly the block's own range
	// replaced by whatever the chosen side contributed.
	const replacement = resolved.slice(
		block.startOffset,
		resolved.length - (text.length - block.endOffset),
	);
	const start = model.getPositionAt(block.startOffset);
	const end = model.getPositionAt(block.endOffset);

	ed.executeEdits("abundio.conflict", [
		{
			range: {
				startLineNumber: start.lineNumber,
				startColumn: start.column,
				endLineNumber: end.lineNumber,
				endColumn: end.column,
			},
			text: replacement,
			forceMoveMarkers: true,
		},
	]);
	ed.pushUndoStop();
}

export type { IDisposable };
