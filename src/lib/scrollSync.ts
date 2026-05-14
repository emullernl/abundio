import type { editor } from "monaco-editor";

/**
 * Bidirectional, line-anchored scroll sync between a Monaco editor and its
 * markdown preview pane.
 *
 * The editor and the preview each register here keyed by the file pane's id
 * (the preview's `sourcePaneId` is that same id). When both halves of a pair
 * are present a link is formed: scrolling one drives the other.
 *
 * Mapping uses `[data-source-line]` anchors stamped into the preview DOM by
 * `rehypeSourceLines`. When no anchors are present it falls back to a plain
 * proportional mapping, so sync always does *something*.
 */

type Anchor = { line: number; top: number };

const editors = new Map<string, editor.IStandaloneCodeEditor>();
const previews = new Map<string, HTMLElement>();
const linkDisposers = new Map<string, () => void>();

const clamp = (n: number, lo: number, hi: number) =>
	Math.min(Math.max(n, lo), hi);

/** Element offsets within the preview's scrollable content, keyed by source line. */
function collectAnchors(previewEl: HTMLElement): Anchor[] {
	// Offset of content origin in viewport space — getBoundingClientRect and
	// scrollTop are both in the same (zoomed) coordinate space, so this stays
	// consistent even though the rendered markdown carries a CSS `zoom`.
	const base = previewEl.getBoundingClientRect().top - previewEl.scrollTop;
	const anchors: Anchor[] = [];
	for (const el of previewEl.querySelectorAll<HTMLElement>(
		"[data-source-line]",
	)) {
		const line = Number(el.getAttribute("data-source-line"));
		if (!Number.isFinite(line)) continue;
		anchors.push({ line, top: el.getBoundingClientRect().top - base });
	}
	anchors.sort((a, b) => a.line - b.line);
	return anchors;
}

/** Fractional source line at the top of the editor viewport. */
function editorTopLine(ed: editor.IStandaloneCodeEditor): number {
	const ranges = ed.getVisibleRanges();
	const topLine = ranges[0]?.startLineNumber ?? 1;
	const scrollTop = ed.getScrollTop();
	const lineTop = ed.getTopForLineNumber(topLine);
	const nextTop = ed.getTopForLineNumber(topLine + 1);
	const frac =
		nextTop > lineTop
			? clamp((scrollTop - lineTop) / (nextTop - lineTop), 0, 1)
			: 0;
	return topLine + frac;
}

/** preview scrollTop for a given (fractional) source line. */
function previewTopForLine(
	anchors: Anchor[],
	line: number,
	ed: editor.IStandaloneCodeEditor,
	previewEl: HTMLElement,
): number {
	const maxScroll = Math.max(
		0,
		previewEl.scrollHeight - previewEl.clientHeight,
	);
	if (anchors.length === 0) {
		const total = ed.getModel()?.getLineCount() ?? 1;
		return clamp((line - 1) / Math.max(1, total - 1), 0, 1) * maxScroll;
	}
	let lo = anchors[0];
	let hi = anchors[anchors.length - 1];
	for (const a of anchors) {
		if (a.line <= line) lo = a;
		else {
			hi = a;
			break;
		}
	}
	if (hi.line <= lo.line) return clamp(lo.top, 0, maxScroll);
	const t = clamp((line - lo.line) / (hi.line - lo.line), 0, 1);
	return clamp(lo.top + t * (hi.top - lo.top), 0, maxScroll);
}

/** Fractional source line for a given preview scrollTop. */
function lineForPreviewTop(
	anchors: Anchor[],
	scrollTop: number,
	ed: editor.IStandaloneCodeEditor,
	previewEl: HTMLElement,
): number {
	if (anchors.length === 0) {
		const total = ed.getModel()?.getLineCount() ?? 1;
		const maxScroll = Math.max(
			1,
			previewEl.scrollHeight - previewEl.clientHeight,
		);
		return 1 + clamp(scrollTop / maxScroll, 0, 1) * (total - 1);
	}
	let lo = anchors[0];
	let hi = anchors[anchors.length - 1];
	for (const a of anchors) {
		if (a.top <= scrollTop) lo = a;
		else {
			hi = a;
			break;
		}
	}
	if (hi.top <= lo.top) return lo.line;
	const t = clamp((scrollTop - lo.top) / (hi.top - lo.top), 0, 1);
	return lo.line + t * (hi.line - lo.line);
}

function createLink(
	ed: editor.IStandaloneCodeEditor,
	previewEl: HTMLElement,
): () => void {
	// Mutual-exclusion lock: a programmatic scroll on one side echoes a scroll
	// event back from the other. Whoever the user is actively scrolling owns
	// the lock for a short window; the other side ignores events meanwhile.
	let owner: "editor" | "preview" | null = null;
	let lockUntil = 0;
	let editorRaf = 0;
	let previewRaf = 0;

	const syncEditorToPreview = () => {
		previewEl.scrollTop = previewTopForLine(
			collectAnchors(previewEl),
			editorTopLine(ed),
			ed,
			previewEl,
		);
	};

	const syncPreviewToEditor = () => {
		const line = lineForPreviewTop(
			collectAnchors(previewEl),
			previewEl.scrollTop,
			ed,
			previewEl,
		);
		const lineNo = Math.max(1, Math.floor(line));
		const top = ed.getTopForLineNumber(lineNo);
		const nextTop = ed.getTopForLineNumber(lineNo + 1);
		ed.setScrollTop(top + (line - lineNo) * Math.max(0, nextTop - top));
	};

	const onEditorScroll = () => {
		if (owner === "preview" && performance.now() < lockUntil) return;
		if (editorRaf) return;
		editorRaf = requestAnimationFrame(() => {
			editorRaf = 0;
			owner = "editor";
			lockUntil = performance.now() + 150;
			syncEditorToPreview();
		});
	};

	const onPreviewScroll = () => {
		if (owner === "editor" && performance.now() < lockUntil) return;
		if (previewRaf) return;
		previewRaf = requestAnimationFrame(() => {
			previewRaf = 0;
			owner = "preview";
			lockUntil = performance.now() + 150;
			syncPreviewToEditor();
		});
	};

	const scrollDisposable = ed.onDidScrollChange((e) => {
		if (e.scrollTopChanged) onEditorScroll();
	});
	previewEl.addEventListener("scroll", onPreviewScroll, { passive: true });

	// Align once on link-up (editor drives).
	requestAnimationFrame(syncEditorToPreview);

	return () => {
		scrollDisposable.dispose();
		previewEl.removeEventListener("scroll", onPreviewScroll);
		if (editorRaf) cancelAnimationFrame(editorRaf);
		if (previewRaf) cancelAnimationFrame(previewRaf);
	};
}

function unlink(paneId: string): void {
	const dispose = linkDisposers.get(paneId);
	if (dispose) {
		dispose();
		linkDisposers.delete(paneId);
	}
}

function maybeLink(paneId: string): void {
	if (linkDisposers.has(paneId)) return;
	const ed = editors.get(paneId);
	const previewEl = previews.get(paneId);
	if (ed && previewEl) linkDisposers.set(paneId, createLink(ed, previewEl));
}

export function registerSyncEditor(
	paneId: string,
	ed: editor.IStandaloneCodeEditor,
): void {
	unlink(paneId); // drop any stale link before relinking with the fresh handle
	editors.set(paneId, ed);
	maybeLink(paneId);
}

export function unregisterSyncEditor(paneId: string): void {
	editors.delete(paneId);
	unlink(paneId);
}

export function registerSyncPreview(
	paneId: string,
	previewEl: HTMLElement,
): void {
	unlink(paneId);
	previews.set(paneId, previewEl);
	maybeLink(paneId);
}

export function unregisterSyncPreview(paneId: string): void {
	previews.delete(paneId);
	unlink(paneId);
}
