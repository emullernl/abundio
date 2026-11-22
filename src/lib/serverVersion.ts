/**
 * A connect the Host refused because its server is another version than
 * this app (the handshake wants the exact version, `host_protocol.rs`).
 * Pure. `null` for any other failure.
 */
export function serverVersionMismatch(
	reason: string,
): { server: string; app: string } | null {
	const m = /server is version ([^\s(;]+).*?the app is ([^\s(;]+)/.exec(reason);
	return m ? { server: m[1], app: m[2] } : null;
}

/** The banner's line for it. */
export function serverUpdateTitle(
	hostName: string,
	v: { server: string; app: string },
): string {
	return `${hostName} runs server ${v.server}; this app needs ${v.app}.`;
}
