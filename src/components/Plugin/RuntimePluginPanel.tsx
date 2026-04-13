import * as ReactNS from "react";
import { useEffect, useState } from "react";
import * as ts from "typescript";
import { fs, plugins as pluginsIpc, salesforce as salesforceIpc } from "../../lib/ipc";
import type { Plugin } from "../../lib/types";

type RuntimeApi = {
	react: typeof ReactNS;
	salesforce: typeof salesforceIpc;
};

declare global {
	interface Window {
		__abundioPluginApi?: RuntimeApi;
	}
}

function buildPanelPath(plugin: Plugin, panelFile: string): string {
	const base = plugin.dir.replace(/[\\/]+$/, "");
	return `${base}/${panelFile}`;
}

function rewritePluginImports(source: string): string {
	let out = source;

	out = out.replace(
		/import\s+\{\s*useEffect\s*,\s*useState\s*\}\s+from\s+["']react["'];?/g,
		"const { useEffect, useState } = window.__abundioPluginApi.react;",
	);

	out = out.replace(
		/import\s+\{\s*salesforce\s+as\s+sfIpc\s*\}\s+from\s+["'][^"']+["'];?/g,
		"const { salesforce: sfIpc } = window.__abundioPluginApi;",
	);

	// Drop type-only imports from plugin source.
	out = out.replace(/import\s+type\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?\n?/g, "");

	return out;
}

export function RuntimePluginPanel({ pluginId }: { pluginId: string }) {
	const [Component, setComponent] = useState<React.ComponentType | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let canceled = false;
		let moduleUrl: string | null = null;

		window.__abundioPluginApi = {
			react: ReactNS,
			salesforce: salesforceIpc,
		};

		const load = async () => {
			setLoading(true);
			setError(null);
			setComponent(null);

			try {
				const installed = await pluginsIpc.list();
				const plugin = installed.find((p) => p.id === pluginId);
				if (!plugin) {
					throw new Error(`Plugin '${pluginId}' is not installed`);
				}

				const panelFile = plugin.manifest.ui?.panel;
				if (!panelFile) {
					throw new Error(`Plugin '${pluginId}' has no UI panel configured`);
				}

				const filePath = buildPanelPath(plugin, panelFile);
				const file = await fs.readFile(filePath);
				if (file.fileType !== "text" || !file.content) {
					throw new Error(`Plugin panel '${panelFile}' is not a readable text file`);
				}

				const rewritten = rewritePluginImports(file.content);
				const transpiled = ts.transpileModule(rewritten, {
					compilerOptions: {
						target: ts.ScriptTarget.ES2020,
						module: ts.ModuleKind.ESNext,
						jsx: ts.JsxEmit.React,
						jsxFactory: "window.__abundioPluginApi.react.createElement",
						jsxFragmentFactory: "window.__abundioPluginApi.react.Fragment",
					},
				});

				moduleUrl = URL.createObjectURL(
					new Blob([transpiled.outputText], { type: "text/javascript" }),
				);
				const mod = await import(/* @vite-ignore */ moduleUrl);
				if (canceled) return;

				if (!mod.default) {
					throw new Error(`Plugin panel '${panelFile}' has no default export`);
				}

				setComponent(() => mod.default as React.ComponentType);
			} catch (err) {
				if (canceled) return;
				setError(err instanceof Error ? err.message : "Failed to load plugin panel");
			} finally {
				if (!canceled) {
					setLoading(false);
				}
			}
		};

		void load();

		return () => {
			canceled = true;
			if (moduleUrl) {
				URL.revokeObjectURL(moduleUrl);
			}
		};
	}, [pluginId]);

	if (loading) {
		return <div style={{ padding: 12, color: "var(--fg-secondary)" }}>Loading...</div>;
	}

	if (error) {
		return (
			<div style={{ padding: 12, color: "var(--error)" }}>
				Plugin load error: {error}
			</div>
		);
	}

	if (!Component) {
		return <div style={{ padding: 12, color: "var(--fg-secondary)" }}>No panel</div>;
	}

	return <Component />;
}
