import { useCallback, useEffect, useRef, useState } from "react";
import { pty } from "../lib/ipc";
import type { PtyStatusType } from "../lib/types";

interface UsePtyOptions {
	cwd: string;
	cols: number;
	rows: number;
	command?: string;
	onData?: (data: Uint8Array) => void;
	onStatus?: (status: PtyStatusType) => void;
}

export function usePty({
	cwd,
	cols,
	rows,
	command,
	onData,
	onStatus,
}: UsePtyOptions) {
	const [ptyId, setPtyId] = useState<string | null>(null);
	const [status, setStatus] = useState<PtyStatusType>({ type: "running" });
	const unlistenOutputRef = useRef<(() => void) | null>(null);
	const unlistenStatusRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		let cancelled = false;

		async function spawn() {
			const id = await pty.spawn(cwd, cols, rows, command);
			if (cancelled) {
				pty.kill(id);
				return;
			}
			setPtyId(id);

			const unlistenOutput = await pty.onOutput(id, (data) => {
				onData?.(data);
			});
			unlistenOutputRef.current = unlistenOutput;

			const unlistenStatus = await pty.onStatus(id, (s) => {
				setStatus(s);
				onStatus?.(s);
			});
			unlistenStatusRef.current = unlistenStatus;
		}

		spawn();

		return () => {
			cancelled = true;
			unlistenOutputRef.current?.();
			unlistenStatusRef.current?.();
			if (ptyId) {
				pty.kill(ptyId);
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cwd, command, cols, onData, onStatus, ptyId, rows]);

	const write = useCallback(
		(data: string) => {
			if (ptyId) pty.write(ptyId, data);
		},
		[ptyId],
	);

	const resize = useCallback(
		(newCols: number, newRows: number) => {
			if (ptyId) pty.resize(ptyId, newCols, newRows);
		},
		[ptyId],
	);

	const kill = useCallback(() => {
		if (ptyId) pty.kill(ptyId);
	}, [ptyId]);

	return { ptyId, status, write, resize, kill };
}
