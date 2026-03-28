import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionWithTabs } from "../../lib/types";
import { useSessionStore } from "../../stores/sessionStore";
import { SessionItem } from "./SessionItem";

const DRAG_THRESHOLD = 5;

export function SessionList() {
	const { sessions, activeSessionId, setActiveSession, deleteSession, reorderSessions } =
		useSessionStore();

	const [draggedId, setDraggedId] = useState<string | null>(null);
	const [mousePos, setMousePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
	const [ghostWidth, setGhostWidth] = useState(0);
	const [nearestSlot, setNearestSlot] = useState<number | null>(null);

	const startPos = useRef<{ x: number; y: number } | null>(null);
	const pendingId = useRef<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	// Store refs to each item's DOM element to compute slot positions
	const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

	const handleMouseDown = useCallback((e: React.MouseEvent, id: string) => {
		if (e.button !== 0) return;
		if ((e.target as HTMLElement).closest("button")) return;
		e.preventDefault();
		pendingId.current = id;
		startPos.current = { x: e.clientX, y: e.clientY };
	}, []);

	useEffect(() => {
		const onMouseMove = (e: MouseEvent) => {
			if (!startPos.current) return;
			const dx = e.clientX - startPos.current.x;
			const dy = e.clientY - startPos.current.y;
			if (Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD && pendingId.current) {
				setDraggedId(pendingId.current);
				setGhostWidth(containerRef.current?.getBoundingClientRect().width ?? 200);
				pendingId.current = null;
			}
		};

		const onMouseUp = () => {
			startPos.current = null;
			pendingId.current = null;
		};

		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
		return () => {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
		};
	}, []);

	// While dragging, track mouse position and compute nearest drop slot
	useEffect(() => {
		if (draggedId === null) return;
		const draggedIndex = sessions.findIndex((s) => s.id === draggedId);

		const onMouseMove = (e: MouseEvent) => {
			setMousePos({ x: e.clientX, y: e.clientY });

			// Compute which slot the cursor is nearest to
			let bestSlot: number | null = null;
			let bestDist = Number.POSITIVE_INFINITY;

			for (let i = 0; i <= sessions.length; i++) {
				// Skip adjacent slots (no-op positions)
				if (i === draggedIndex || i === draggedIndex + 1) continue;

				// Slot i is the gap before item i (or after last item)
				let slotY: number;
				if (i < sessions.length) {
					const el = itemRefs.current.get(i);
					if (!el) continue;
					slotY = el.getBoundingClientRect().top;
				} else {
					const el = itemRefs.current.get(sessions.length - 1);
					if (!el) continue;
					slotY = el.getBoundingClientRect().bottom;
				}

				const dist = Math.abs(e.clientY - slotY);
				if (dist < bestDist && dist < 40) {
					bestDist = dist;
					bestSlot = i;
				}
			}

			setNearestSlot(bestSlot);
		};

		const onMouseUp = () => {
			// Perform drop if we have a valid slot
			setNearestSlot((slot) => {
				if (slot !== null) {
					const currentIdx = sessions.findIndex((s) => s.id === draggedId);
					if (currentIdx !== -1 && slot !== currentIdx && slot !== currentIdx + 1) {
						const ids = sessions.map((s) => s.id);
						ids.splice(currentIdx, 1);
						const insertAt = slot > currentIdx ? slot - 1 : slot;
						ids.splice(insertAt, 0, draggedId);
						reorderSessions(ids);
					}
				}
				return null;
			});
			setDraggedId(null);
		};

		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
		return () => {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
		};
	}, [draggedId, sessions, reorderSessions]);

	const draggedSession = draggedId ? sessions.find((s) => s.id === draggedId) : null;

	return (
		<div className="flex flex-col" ref={containerRef}>
			{sessions.length === 0 && (
				<div className="px-3 py-4 text-center text-xs" style={{ color: "var(--fg-secondary)" }}>
					No sessions yet
				</div>
			)}
			{sessions.map((session, i) => (
				<div
					key={session.id}
					ref={(el) => {
						if (el) itemRefs.current.set(i, el);
						else itemRefs.current.delete(i);
					}}
				>
					{nearestSlot === i && <DropIndicator />}
					<SessionItem
						session={session}
						isActive={session.id === activeSessionId}
						isDragging={session.id === draggedId}
						onClick={() => {
							if (draggedId) return;
							setActiveSession(session.id);
						}}
						onDelete={() => deleteSession(session.id)}
						onMouseDown={(e) => handleMouseDown(e, session.id)}
					/>
				</div>
			))}
			{nearestSlot === sessions.length && <DropIndicator />}

			{/* Floating ghost following the cursor */}
			{draggedSession && (
				<DragGhost session={draggedSession} mousePos={mousePos} width={ghostWidth} />
			)}
		</div>
	);
}

function DropIndicator() {
	return (
		<div
			className="mx-2 my-0.5 rounded-md"
			style={{
				height: 36,
				border: "2px dashed var(--accent)",
				backgroundColor: "color-mix(in srgb, var(--accent) 10%, transparent)",
			}}
		/>
	);
}

function DragGhost({
	session,
	mousePos,
	width,
}: {
	session: SessionWithTabs;
	mousePos: { x: number; y: number };
	width: number;
}) {
	return (
		<div
			className="pointer-events-none"
			style={{
				position: "fixed",
				left: mousePos.x + 8,
				top: mousePos.y - 20,
				width,
				opacity: 0.75,
				zIndex: 9999,
				filter: "drop-shadow(0 4px 12px rgba(0, 0, 0, 0.3))",
			}}
		>
			<SessionItem
				session={session}
				isActive={false}
				isDragging={false}
				onClick={() => {}}
				onDelete={() => {}}
				onMouseDown={() => {}}
			/>
		</div>
	);
}
