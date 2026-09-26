import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	type Chord,
	chordsEqual,
	formatChord,
	hasOverride,
	type KeybindingOverrides,
} from "../../lib/chords";
import {
	ACTION_META,
	APP_ACTIONS,
	appOverrideId,
	defaultChord,
	effectiveChord,
	isWorkspaceGlobal,
	type KeyAction,
	type ShortcutCategory,
} from "../../lib/keybindings";
import { type KeymapEntry, planRecording } from "../../lib/keymapConflicts";
import {
	type EditorShortcut,
	editorOverrideId,
	loadMonacoCatalogue,
} from "../../lib/monacoKeymap";
import { isMac } from "../../lib/platform";
import { useSettingsStore } from "../../stores/settingsStore";
import { secondaryButtonClass } from "../PromptActions/fieldStyles";
import { ChordRecorder } from "./ChordRecorder";
import { SearchInput, SectionLabel } from "./primitives";

type Group = "app" | "editor";

const CATEGORY_ORDER: ShortcutCategory[] = [
	"Panes",
	"Tabs",
	"Workspaces",
	"Panels",
	"Fleet Console",
	"Terminal",
	"Files",
	"App",
	"Prompt actions",
];

/** A row's shortcut as the keymap sees it. */
interface Row {
	entry: KeymapEntry;
	/** The built-in chord, used to tell "changed" from "default". */
	fallback: Chord | null;
	/** Monaco's own spelling of a default we cannot model (a two-step
	 *  sequence); shown only while the row is not overridden. */
	fallbackLabel: string | null;
	overridden: boolean;
	category?: ShortcutCategory;
}

/** Font size is forwarded out of the editor by `CodeEditor`, so it clashes
 *  with editor actions just as a workspace-global action does. */
function firesInEditor(action: KeyAction): boolean {
	return (
		isWorkspaceGlobal(action) ||
		action === "font-size-increase" ||
		action === "font-size-decrease"
	);
}

function has(overrides: KeybindingOverrides, id: string): boolean {
	return hasOverride(overrides, id);
}

export function appRows(overrides: KeybindingOverrides): Row[] {
	return APP_ACTIONS.map((action) => {
		const id = appOverrideId(action);
		const meta = ACTION_META[action];
		return {
			entry: {
				id,
				label: meta.label,
				scope: "app",
				chord: effectiveChord(action, overrides),
				global: firesInEditor(action),
			},
			fallback: defaultChord(action),
			fallbackLabel: null,
			overridden: has(overrides, id),
			category: meta.category,
		};
	});
}

export function editorRows(
	catalogue: readonly EditorShortcut[],
	overrides: KeybindingOverrides,
): Row[] {
	return catalogue.map((a) => {
		const id = editorOverrideId(a.id);
		const overridden = has(overrides, id);
		return {
			entry: {
				id,
				label: a.label,
				scope: "editor",
				chord: overridden ? overrides[id] : a.defaultChord,
			},
			fallback: a.defaultChord,
			fallbackLabel: a.defaultChord ? null : a.defaultLabel,
			overridden,
		};
	});
}

function rowLabel(row: Row): string | null {
	if (row.entry.chord) return formatChord(row.entry.chord, isMac);
	if (!row.overridden && row.fallbackLabel) return row.fallbackLabel;
	return null;
}

function matches(row: Row, query: string): boolean {
	if (!query) return true;
	const q = query.toLowerCase();
	if (row.entry.label.toLowerCase().includes(q)) return true;
	const label = rowLabel(row);
	return !!label && label.toLowerCase().includes(q);
}

type Message = { id: string; tone: "error" | "warn"; text: string };
type Pending = {
	id: string;
	chord: Chord;
	other: KeymapEntry;
	warning: string | null;
};

type CatalogueState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "ready"; items: EditorShortcut[] }
	| { status: "error" };

// One load per Settings window: Monaco is fetched once and the catalogue does
// not change while the app runs.
let catalogueCache: EditorShortcut[] | null = null;

/**
 * Settings ▸ Keyboard: every app Shortcut and every labelled editor action,
 * each with a chord pill to record a new Chord, unbind (Backspace) or reset.
 * Only Overrides are written; resetting deletes the entry. See ADR-0043 and CONTEXT.md (Shortcut).
 */
export function KeyboardSection() {
	const overrides = useSettingsStore((s) => s.keybindingOverrides);
	const setOverrides = useSettingsStore((s) => s.setKeybindingOverrides);
	const resetKeybinding = useSettingsStore((s) => s.resetKeybinding);
	const resetAll = useSettingsStore((s) => s.resetAllKeybindings);

	const [group, setGroup] = useState<Group>("app");
	const [query, setQuery] = useState("");
	const [recording, setRecording] = useState<string | null>(null);
	const [pending, setPending] = useState<Pending | null>(null);
	const [message, setMessage] = useState<Message | null>(null);
	const [catalogue, setCatalogue] = useState<CatalogueState>(
		catalogueCache
			? { status: "ready", items: catalogueCache }
			: { status: "idle" },
	);

	const loadCatalogue = useCallback(() => {
		setCatalogue({ status: "loading" });
		loadMonacoCatalogue()
			.then((items) => {
				catalogueCache = items;
				setCatalogue({ status: "ready", items });
			})
			.catch((err) => {
				console.error("[keymap] loading the editor actions failed:", err);
				setCatalogue({ status: "error" });
			});
	}, []);

	useEffect(() => {
		if (group === "editor" && catalogue.status === "idle") loadCatalogue();
	}, [group, catalogue.status, loadCatalogue]);

	const app = useMemo(() => appRows(overrides), [overrides]);
	const editor = useMemo(
		() =>
			catalogue.status === "ready"
				? editorRows(catalogue.items, overrides)
				: [],
		[catalogue, overrides],
	);
	const allEntries = useMemo(
		() => [...app, ...editor].map((r) => r.entry),
		[app, editor],
	);

	/** Write a Chord (or Unbound) for one row, plus any Reassign. A Chord equal
	 *  to the default deletes the Override instead, so the row reads "default"
	 *  again and follows later releases. One store write either way, so no
	 *  Window ever samples a state with the Chord on two actions. */
	const commit = useCallback(
		(row: Row, chord: Chord | null, unbind?: string) => {
			const backToDefault =
				!!chord && !!row.fallback && chordsEqual(chord, row.fallback);
			const changes: KeybindingOverrides = {};
			if (!backToDefault) changes[row.entry.id] = chord;
			if (unbind) changes[unbind] = null;
			setOverrides(changes, backToDefault ? [row.entry.id] : []);
		},
		[setOverrides],
	);

	const onRecord = (row: Row, chord: Chord) => {
		setRecording(null);
		const plan = planRecording(row.entry, chord, allEntries, isMac);
		if (plan.kind === "refuse") {
			setMessage({ id: row.entry.id, tone: "error", text: plan.reason });
			return;
		}
		if (plan.kind === "ask") {
			setPending({
				id: row.entry.id,
				chord,
				other: plan.other,
				warning: plan.warning,
			});
			return;
		}
		commit(row, chord);
		setMessage(
			plan.notice
				? { id: row.entry.id, tone: "warn", text: plan.notice }
				: null,
		);
	};

	const rows = group === "app" ? app : editor;
	const visible = rows.filter((r) => matches(r, query));
	const anyOverride = Object.keys(overrides).length > 0;

	const renderRow = (row: Row) => {
		const id = row.entry.id;
		const isPending = pending?.id === id;
		const note = message?.id === id ? message : null;
		return (
			<div
				key={id}
				className="flex flex-col"
				style={{ borderTop: "1px solid var(--border)" }}
			>
				<div
					className="flex items-center gap-3"
					style={{ padding: "7px 12px" }}
				>
					<span
						className="flex-1 min-w-0 truncate"
						style={{ fontSize: 12.5, color: "var(--fg-primary)" }}
						title={row.entry.scope === "editor" ? id.slice(7) : undefined}
					>
						{row.entry.label}
					</span>
					{row.overridden && (
						<span
							aria-hidden="true"
							title="Changed from the default"
							className="flex-shrink-0 rounded-full"
							style={{ width: 6, height: 6, backgroundColor: "var(--accent)" }}
						/>
					)}
					<ChordRecorder
						label={rowLabel(row)}
						actionLabel={row.entry.label}
						recording={recording === id}
						onStart={() => {
							setRecording(id);
							setPending(null);
							setMessage(null);
						}}
						onCancel={() => setRecording(null)}
						onUnbind={() => {
							setRecording(null);
							commit(row, null);
						}}
						onRecord={(chord) => onRecord(row, chord)}
						onUnsupported={() =>
							setMessage({
								id,
								tone: "error",
								text: "That key can't be used as a shortcut. Try another.",
							})
						}
					/>
					<button
						type="button"
						disabled={!row.overridden}
						onClick={() => {
							resetKeybinding(id);
							setMessage(null);
						}}
						aria-label={`Reset ${row.entry.label} to its default`}
						title="Reset to default"
						className="flex items-center justify-center flex-shrink-0 rounded text-[var(--fg-secondary)] enabled:hover:text-[var(--fg-primary)] enabled:hover:bg-[var(--bg-tertiary)] enabled:cursor-pointer disabled:opacity-0"
						style={{ width: 22, height: 22 }}
					>
						<RotateCcw size={12} />
					</button>
				</div>
				{isPending && pending && (
					<div
						role="alert"
						className="flex items-center gap-2 flex-wrap"
						style={{
							padding: "0 12px 9px",
							fontSize: 11.5,
							color: "var(--fg-secondary)",
						}}
					>
						<span className="flex-1 min-w-0">
							<span style={{ color: "var(--fg-primary)" }}>
								{formatChord(pending.chord, isMac)}
							</span>{" "}
							is already used by “{pending.other.label}”.
							{pending.warning ? ` ${pending.warning}` : ""}
						</span>
						<button
							type="button"
							className={secondaryButtonClass}
							style={{
								height: 24,
								padding: "0 10px",
								borderRadius: 6,
								fontSize: 11.5,
							}}
							onClick={() => {
								commit(row, pending.chord, pending.other.id);
								setPending(null);
								setMessage(
									pending.warning
										? { id, tone: "warn", text: pending.warning }
										: null,
								);
							}}
						>
							Reassign
						</button>
						<button
							type="button"
							className={secondaryButtonClass}
							style={{
								height: 24,
								padding: "0 10px",
								borderRadius: 6,
								fontSize: 11.5,
							}}
							onClick={() => setPending(null)}
						>
							Cancel
						</button>
					</div>
				)}
				{note && (
					<div
						role={note.tone === "error" ? "alert" : "status"}
						style={{
							padding: "0 12px 9px",
							fontSize: 11.5,
							lineHeight: 1.45,
							color: note.tone === "error" ? "var(--error)" : "var(--warning)",
						}}
					>
						{note.text}
					</div>
				)}
			</div>
		);
	};

	const card = (children: React.ReactNode) => (
		<div
			className="rounded-lg overflow-hidden"
			style={{
				backgroundColor: "var(--bg-primary)",
				border: "1px solid var(--border)",
			}}
		>
			{/* Rows draw a top border; the first one would double the card's. */}
			<div style={{ marginTop: -1 }}>{children}</div>
		</div>
	);

	return (
		<div className="flex flex-col gap-4 flex-1 min-h-0">
			<div className="flex flex-col gap-3 flex-shrink-0">
				<div className="flex items-start gap-3">
					<p
						className="flex-1"
						style={{
							fontSize: 11.5,
							lineHeight: 1.5,
							color: "var(--fg-secondary)",
						}}
					>
						Click a shortcut, then press the new keys. Esc cancels; Backspace
						removes the shortcut. Keys typed into a terminal are not listed:
						they belong to the program running there.
					</p>
					<button
						type="button"
						disabled={!anyOverride}
						onClick={() => {
							resetAll();
							setPending(null);
							setMessage(null);
						}}
						className={secondaryButtonClass}
						style={{
							height: 28,
							padding: "0 12px",
							borderRadius: 6,
							fontSize: 12,
						}}
					>
						<RotateCcw size={12} />
						Reset all
					</button>
				</div>
				<div className="flex items-center gap-2">
					<div
						role="tablist"
						aria-label="Shortcut group"
						className="flex flex-shrink-0 rounded-md"
						style={{ border: "1px solid var(--border)", padding: 2, gap: 2 }}
					>
						{(["app", "editor"] as const).map((g) => (
							<button
								key={g}
								type="button"
								role="tab"
								aria-selected={group === g}
								onClick={() => {
									setGroup(g);
									setRecording(null);
									setPending(null);
									setMessage(null);
								}}
								className={
									"rounded cursor-pointer transition-colors " +
									(group === g
										? "bg-[var(--bg-tertiary)] text-[var(--fg-primary)]"
										: "text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]")
								}
								style={{ height: 24, padding: "0 12px", fontSize: 12 }}
							>
								{g === "app" ? "App" : "Editor"}
							</button>
						))}
					</div>
					<div className="flex-1">
						<SearchInput
							value={query}
							onChange={setQuery}
							placeholder="Search by name or keys"
						/>
					</div>
				</div>
			</div>

			<div className="flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto">
				{group === "app" &&
					CATEGORY_ORDER.map((category) => {
						const inCategory = visible.filter((r) => r.category === category);
						if (inCategory.length === 0) return null;
						return (
							<div key={category} className="flex-shrink-0">
								<SectionLabel>{category}</SectionLabel>
								{card(inCategory.map(renderRow))}
							</div>
						);
					})}

				{group === "editor" && catalogue.status !== "ready" && (
					<div
						className="flex flex-col items-start gap-3 rounded-lg"
						style={{
							padding: "16px 14px",
							border: "1px dashed var(--border)",
							fontSize: 12,
							color: "var(--fg-secondary)",
						}}
					>
						{catalogue.status === "error" ? (
							<>
								<span>
									The editor could not be loaded, so its actions cannot be
									listed. It is fetched from the internet the first time; check
									your connection and try again.
								</span>
								<button
									type="button"
									onClick={loadCatalogue}
									className={secondaryButtonClass}
									style={{
										height: 26,
										padding: "0 12px",
										borderRadius: 6,
										fontSize: 12,
									}}
								>
									Retry
								</button>
							</>
						) : (
							<span>Loading the editor's actions…</span>
						)}
					</div>
				)}

				{group === "editor" && catalogue.status === "ready" && (
					<div className="flex-shrink-0">
						<SectionLabel>Editor actions</SectionLabel>
						<p
							style={{
								fontSize: 11.5,
								lineHeight: 1.5,
								color: "var(--fg-secondary)",
								marginBottom: 10,
							}}
						>
							Apply in open files and diffs. A new shortcut replaces all of the
							action's defaults.
						</p>
						{visible.length > 0 && card(visible.map(renderRow))}
					</div>
				)}

				{visible.length === 0 &&
					query &&
					(group === "app" || catalogue.status === "ready") && (
						<p style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
							No shortcut matches “{query}”.
						</p>
					)}
			</div>
		</div>
	);
}
