// Deliberate user input into a pane's terminal (a keystroke or paste, never
// a focus or mouse report). terminalManager reports it; anything that ends
// when the user engages with a pane listens (the **Attention flag**,
// ADR-0056). A plain module with no imports, so terminalManager can use it
// without pulling in stores.

type Listener = (paneId: string) => void;
const listeners = new Set<Listener>();

export function notePaneInput(paneId: string): void {
	for (const l of listeners) l(paneId);
}

export function onPaneInput(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
