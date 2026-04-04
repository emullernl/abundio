import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSplitPane } from "../hooks/useSplitPane";
import { pty } from "../lib/ipc";
import { triggerAction } from "../lib/keybindings";
import { getTerminal } from "../lib/terminalManager";
import { themeList } from "../lib/themes";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";

interface PaletteItem {
	id: string;
	label: string;
	category: string;
	action: () => void;
}

function fuzzyMatch(query: string, text: string): number {
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	if (q.length === 0) return 1;
	if (t.includes(q)) return 2 + q.length / t.length;

	let qi = 0;
	let score = 0;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			score += 1;
			qi++;
		}
	}
	return qi === q.length ? score / t.length : 0;
}

interface Props {
	open: boolean;
	onClose: () => void;
}

export function CommandPalette({ open: isOpen, onClose }: Props) {
	const [query, setQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const { sessions, setActiveSession, createSession, focusedPaneId } =
		useSessionStore();
	const { setTheme, debugActivityMeter, toggleDebugActivityMeter, agents } =
		useSettingsStore();
	const { splitPane, closePane, toggleMaximize } = useSplitPane();

	const items = useMemo<PaletteItem[]>(() => {
		const result: PaletteItem[] = [];

		// Sessions
		for (const s of sessions) {
			result.push({
				id: `session-${s.id}`,
				label: s.name,
				category: "Sessions",
				action: () => setActiveSession(s.id),
			});
		}

		// Actions
		result.push({
			id: "action-new-session",
			label: "New Session",
			category: "Actions",
			action: async () => {
				const folder = await open({ directory: true, multiple: false });
				if (!folder) return;
				const folderPath = typeof folder === "string" ? folder : folder[0];
				if (!folderPath) return;
				const name = folderPath.split("/").pop() || "Untitled";
				await createSession(name, folderPath);
			},
		});

		if (focusedPaneId) {
			result.push(
				{
					id: "action-split-right",
					label: "Split Right",
					category: "Actions",
					action: () => splitPane(focusedPaneId, "vertical"),
				},
				{
					id: "action-split-down",
					label: "Split Down",
					category: "Actions",
					action: () => splitPane(focusedPaneId, "horizontal"),
				},
				{
					id: "action-close-pane",
					label: "Close Pane",
					category: "Actions",
					action: () => closePane(focusedPaneId),
				},
				{
					id: "action-maximize",
					label: "Maximize / Restore Pane",
					category: "Actions",
					action: () => toggleMaximize(),
				},
			);
		}

		result.push({
			id: "action-open-settings",
			label: "Open Settings",
			category: "Actions",
			action: () => triggerAction("open-settings"),
		});

		// Agents
		if (focusedPaneId) {
			for (const agent of agents.filter((a) => a.enabled)) {
				result.push({
					id: `agent-${agent.id}`,
					label: `Launch ${agent.name}`,
					category: "Agents",
					action: () => {
						const managed = getTerminal(focusedPaneId);
						if (!managed?.ptyId) return;
						const cmd = [agent.command, ...(agent.args || [])].join(" ");
						pty.write(managed.ptyId, `${cmd}\n`);
						usePtyActivityStore.getState().setAgentPty(managed.ptyId);
					},
				});
			}
		}

		// Debug
		result.push({
			id: "action-toggle-debug-meter",
			label: `Debug Activity Meter: ${debugActivityMeter ? "On" : "Off"}`,
			category: "Debug",
			action: () => toggleDebugActivityMeter(),
		});

		// Themes
		for (const t of themeList()) {
			result.push({
				id: `theme-${t.name}`,
				label: t.displayName,
				category: "Themes",
				action: () => setTheme(t.name),
			});
		}

		return result;
	}, [
		sessions,
		focusedPaneId,
		setActiveSession,
		createSession,
		splitPane,
		closePane,
		toggleMaximize,
		setTheme,
		debugActivityMeter,
		toggleDebugActivityMeter,
		agents,
	]);

	const filtered = useMemo(() => {
		if (!query) return items;
		return items
			.map((item) => ({ item, score: fuzzyMatch(query, item.label) }))
			.filter(({ score }) => score > 0)
			.sort((a, b) => b.score - a.score)
			.map(({ item }) => item);
	}, [items, query]);

	useEffect(() => {
		if (isOpen) {
			setQuery("");
			setSelectedIndex(0);
			setTimeout(() => inputRef.current?.focus(), 50);
		}
	}, [isOpen]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when query changes
	useEffect(() => {
		setSelectedIndex(0);
	}, [query]);

	// Scroll selected item into view
	useEffect(() => {
		if (!listRef.current) return;
		const selected = listRef.current.children[selectedIndex] as
			| HTMLElement
			| undefined;
		selected?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((i) => Math.max(i - 1, 0));
			} else if (e.key === "Enter" && filtered[selectedIndex]) {
				e.preventDefault();
				filtered[selectedIndex].action();
				onClose();
			} else if (e.key === "Escape") {
				onClose();
			}
		},
		[filtered, selectedIndex, onClose],
	);

	if (!isOpen) return null;

	// Group by category for display
	let lastCategory = "";

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop dismiss
		<div
			role="presentation"
			className="fixed inset-0 z-[200] flex items-start justify-center"
			style={{ paddingTop: 80, backgroundColor: "rgba(0,0,0,0.5)" }}
			onClick={onClose}
			onKeyDown={(e) => e.key === "Escape" && onClose()}
		>
			<div
				role="dialog"
				className="rounded-xl shadow-2xl overflow-hidden flex flex-col"
				style={{
					width: 520,
					maxHeight: 420,
					backgroundColor: "var(--bg-secondary)",
					border: "1px solid var(--border)",
				}}
				onClick={(e) => e.stopPropagation()}
				onKeyDown={handleKeyDown}
			>
				<div
					className="p-3"
					style={{ borderBottom: "1px solid var(--border)" }}
				>
					<input
						ref={inputRef}
						type="text"
						placeholder="Search commands, sessions, agents..."
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						className="w-full bg-transparent outline-none"
						style={{
							color: "var(--fg-primary)",
							fontSize: 15,
							padding: "6px 4px",
						}}
					/>
				</div>
				<div ref={listRef} className="flex-1 overflow-y-auto py-2">
					{filtered.length === 0 && (
						<div
							className="px-4 py-6 text-center"
							style={{ color: "var(--fg-secondary)", fontSize: 14 }}
						>
							No results
						</div>
					)}
					{filtered.map((item, i) => {
						const showCategory = item.category !== lastCategory;
						lastCategory = item.category;
						return (
							<div key={item.id}>
								{showCategory && (
									<div
										className="px-4 pt-3 pb-1 font-semibold"
										style={{
											fontSize: 11,
											color: "var(--fg-secondary)",
											letterSpacing: "0.05em",
											textTransform: "uppercase",
										}}
									>
										{item.category}
									</div>
								)}
								<button
									type="button"
									onClick={() => {
										item.action();
										onClose();
									}}
									onMouseEnter={() => setSelectedIndex(i)}
									className="w-full text-left flex items-center rounded-lg mx-1.5 transition-colors"
									style={{
										padding: "8px 12px",
										fontSize: 14,
										width: "calc(100% - 12px)",
										color:
											i === selectedIndex
												? "var(--bg-primary)"
												: "var(--fg-primary)",
										backgroundColor:
											i === selectedIndex ? "var(--accent)" : "transparent",
									}}
								>
									{item.label}
								</button>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
