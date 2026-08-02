import { AnimatePresence, motion } from "framer-motion";
import { Check, Copy, Zap } from "lucide-react";
import { useState } from "react";
import { useWorkspaceEnvStore } from "../../stores/workspaceEnvStore";

interface Recipe {
	label: string;
	command: string;
	/** One line on what it does, or what it costs. */
	note?: string;
	/** Renders the note as a caution rather than a description. */
	caution?: boolean;
}

interface Section {
	title: string;
	blurb: string;
	recipes: Recipe[];
}

/**
 * How to use an Environment Bundle from a terminal.
 *
 * A sibling *view* of the variables list, not a top-level tab: this is
 * reference material about the Environment tab's contents, so presenting it as
 * a peer of General/Environment read as an unrelated section. It is also not
 * interleaved with the variables — that is a working surface you edit, and
 * mixing the two made both harder to scan.
 *
 * Every command carries the *real* selected bundle name, so each line is
 * copy-paste ready rather than a template to hand-edit.
 */
export function EnvUsageView() {
	const bundles = useWorkspaceEnvStore((s) => s.bundles);
	const selectedBundle = useWorkspaceEnvStore((s) => s.selectedBundle);

	// Local, not the store's selection: choosing which bundle to *read about*
	// should not reload the Environment tab's variable list.
	const [bundle, setBundle] = useState(selectedBundle || "default");
	const active = bundles.find((b) => b.name === bundle);
	const injected = active?.injected ?? false;

	const sections: Section[] = [
		{
			title: "Run something with it",
			blurb:
				"The values land in that command's environment only — never on disk, and never in `ps` output.",
			recipes: [
				{
					label: "Docker Compose",
					command: `abundio-env run ${bundle} -- docker compose up`,
					// biome-ignore lint/suspicious/noTemplateCurlyInString: prose describing compose's own syntax
					note: "Compose resolves ${VAR} interpolation and `environment: [VAR]` passthrough from the shell environment.",
				},
				{
					label: "Node",
					command: `abundio-env run ${bundle} -- node server.js`,
				},
				{
					label: "Any package script",
					command: `abundio-env run ${bundle} -- pnpm dev`,
					note: "Same for npm, yarn, tsx, vitest, pytest, make — anything runnable.",
				},
				{
					label: "A subshell with everything loaded",
					command: `abundio-env run ${bundle} -- $SHELL`,
					note: "Everything you run inside that shell sees the variables.",
				},
			],
		},
		{
			title: "Look at it",
			blurb: "Reading values is deliberate, and it is not free.",
			recipes: [
				{
					label: "Print the values",
					command: `cat <(abundio-env print ${bundle})`,
					// `print` refuses a bare TTY; piping through `cat` is the intended
					// override, so be straight about what it costs.
					note: "Puts the values in this terminal's scrollback, which Abundio saves to disk.",
					caution: true,
				},
				{
					label: "Which bundles exist here",
					command: "abundio-env list",
				},
				{
					label: "Write to a file",
					command: `abundio-env print ${bundle} > .env.local`,
					note: "Back on disk in plain text — the thing bundles exist to avoid. Delete it after.",
					caution: true,
				},
			],
		},
	];

	return (
		<div className="flex flex-col" style={{ gap: 18 }}>
			<div className="flex flex-col" style={{ gap: 8 }}>
				<span style={sectionLabel}>Show commands for</span>
				<div className="flex items-center flex-wrap" style={{ gap: 5 }}>
					{(bundles.length > 0
						? bundles
						: [{ id: "fallback", name: bundle, injected: true }]
					).map((b) => {
						const on = b.name === bundle;
						return (
							<button
								key={b.id || b.name}
								type="button"
								onClick={() => setBundle(b.name)}
								className="flex items-center transition-colors"
								style={{
									gap: 5,
									padding: "3px 10px",
									borderRadius: 999,
									fontFamily: "var(--font-mono, ui-monospace, monospace)",
									fontSize: 11,
									lineHeight: 1.6,
									cursor: "pointer",
									backgroundColor: on
										? "color-mix(in srgb, var(--accent) 16%, var(--bg-primary))"
										: "var(--bg-primary)",
									border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
									color: on ? "var(--fg-primary)" : "var(--fg-secondary)",
								}}
							>
								{b.injected && (
									<Zap size={10} style={{ color: "var(--accent)" }} />
								)}
								{b.name}
							</button>
						);
					})}
				</div>
				<span style={blurbStyle}>
					{injected ? (
						<>
							<strong style={{ color: "var(--fg-primary)", fontWeight: 600 }}>
								{bundle}
							</strong>{" "}
							is already in every terminal in this workspace — you only need
							these commands to inspect it, or to hand it to something running
							outside a pane.
						</>
					) : (
						<>
							<strong style={{ color: "var(--fg-primary)", fontWeight: 600 }}>
								{bundle}
							</strong>{" "}
							is on-demand: it reaches a process only through the commands
							below.
						</>
					)}
				</span>
			</div>

			{/* The mental model in three lines, before any recipe. */}
			<div className="flex flex-col" style={{ gap: 8 }}>
				<span style={sectionLabel}>The helper</span>
				<div
					className="flex flex-col"
					style={{
						borderRadius: 8,
						border: "1px solid var(--border)",
						backgroundColor: "var(--bg-primary)",
						overflow: "hidden",
					}}
				>
					{[
						{
							sig: "run <bundle> -- <command>",
							desc: "Run a command with the bundle applied",
						},
						{
							sig: "print <bundle>",
							desc: 'Write the bundle as KEY="value" lines',
						},
						{ sig: "list", desc: "List the bundles this pane can see" },
					].map((row, i) => (
						<div
							key={row.sig}
							className="flex items-baseline"
							style={{
								gap: 12,
								padding: "7px 12px",
								borderTop: i === 0 ? "none" : "1px solid var(--border)",
							}}
						>
							<code
								style={{
									fontFamily: "var(--font-mono, ui-monospace, monospace)",
									fontSize: 11.5,
									color: "var(--fg-primary)",
									flexShrink: 0,
									minWidth: 210,
								}}
							>
								abundio-env {row.sig}
							</code>
							<span style={{ fontSize: 11, color: "var(--fg-secondary)" }}>
								{row.desc}
							</span>
						</div>
					))}
				</div>
			</div>

			{sections.map((section) => (
				<div key={section.title} className="flex flex-col" style={{ gap: 8 }}>
					<span style={sectionLabel}>{section.title}</span>
					<span style={blurbStyle}>{section.blurb}</span>
					<div
						className="flex flex-col"
						style={{
							borderRadius: 8,
							border: "1px solid var(--border)",
							backgroundColor: "var(--bg-primary)",
							overflow: "hidden",
						}}
					>
						{section.recipes.map((recipe, i) => (
							<RecipeRow key={recipe.label} recipe={recipe} first={i === 0} />
						))}
					</div>
				</div>
			))}

			<div className="flex flex-col" style={{ gap: 8 }}>
				<span style={sectionLabel}>Worth knowing</span>
				<ul
					className="flex flex-col"
					style={{
						gap: 6,
						margin: 0,
						paddingLeft: 16,
						fontSize: 11,
						lineHeight: 1.55,
						color: "var(--fg-secondary)",
					}}
				>
					<li>
						<code style={codeInline}>--env-file &lt;(…)</code> does{" "}
						<strong style={{ color: "var(--fg-primary)" }}>not</strong> work
						with Docker Compose. It needs a real, seekable file and reads a
						process substitution as empty — with no error. Use{" "}
						<code style={codeInline}>run</code>.
					</li>
					<li>
						<code style={codeInline}>print</code> refuses to write to a bare
						terminal, because scrollback is saved to disk. Piping or redirecting
						it is the way past that, deliberately.
					</li>
					<li>
						These commands only work inside an Abundio terminal — they
						authenticate with the pane's own token, and the workspace is derived
						from the pane rather than taken from the command.
					</li>
				</ul>
			</div>
		</div>
	);
}

function RecipeRow({ recipe, first }: { recipe: Recipe; first: boolean }) {
	const [copied, setCopied] = useState(false);
	const [hovered, setHovered] = useState(false);

	const copy = () => {
		navigator.clipboard?.writeText(recipe.command).catch(() => {});
		setCopied(true);
		setTimeout(() => setCopied(false), 1400);
	};

	return (
		<button
			type="button"
			onClick={copy}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			title="Copy command"
			className="flex flex-col text-left transition-colors"
			style={{
				gap: 3,
				padding: "9px 12px",
				width: "100%",
				border: "none",
				borderTop: first ? "none" : "1px solid var(--border)",
				background: hovered
					? "color-mix(in srgb, var(--accent) 7%, transparent)"
					: "transparent",
				cursor: "pointer",
			}}
		>
			<span
				style={{
					fontSize: 10,
					fontWeight: 600,
					letterSpacing: "0.05em",
					color: "var(--fg-secondary)",
				}}
			>
				{recipe.label}
			</span>

			<span className="flex items-center" style={{ gap: 7, width: "100%" }}>
				{/* A prompt glyph, so the line reads unmistakably as something you
				    type rather than a value you set. */}
				<span
					aria-hidden
					style={{
						color: "var(--accent)",
						fontFamily: "var(--font-mono, ui-monospace, monospace)",
						fontSize: 11.5,
						opacity: 0.75,
						flexShrink: 0,
					}}
				>
					$
				</span>
				<code
					style={{
						flex: 1,
						minWidth: 0,
						fontFamily: "var(--font-mono, ui-monospace, monospace)",
						fontSize: 11.5,
						color: "var(--fg-primary)",
						whiteSpace: "pre-wrap",
						wordBreak: "break-word",
					}}
				>
					{recipe.command}
				</code>
				<AnimatePresence initial={false} mode="wait">
					<motion.span
						key={copied ? "copied" : "copy"}
						initial={{ opacity: 0, scale: 0.8 }}
						animate={{ opacity: hovered || copied ? 1 : 0, scale: 1 }}
						exit={{ opacity: 0, scale: 0.8 }}
						transition={{ duration: 0.12 }}
						className="flex items-center"
						style={{
							flexShrink: 0,
							color: copied ? "var(--accent)" : "var(--fg-secondary)",
						}}
					>
						{copied ? <Check size={12} /> : <Copy size={12} />}
					</motion.span>
				</AnimatePresence>
			</span>

			{recipe.note && (
				<span
					style={{
						fontSize: 10.5,
						lineHeight: 1.45,
						color: recipe.caution
							? "color-mix(in srgb, var(--error) 70%, var(--fg-secondary))"
							: "var(--fg-secondary)",
					}}
				>
					{recipe.note}
				</span>
			)}
		</button>
	);
}

const sectionLabel: React.CSSProperties = {
	fontSize: 10.5,
	fontWeight: 600,
	letterSpacing: "0.1em",
	textTransform: "uppercase",
	color: "var(--fg-secondary)",
};

const blurbStyle: React.CSSProperties = {
	fontSize: 11,
	lineHeight: 1.55,
	color: "var(--fg-secondary)",
};

const codeInline: React.CSSProperties = {
	fontFamily: "var(--font-mono, ui-monospace, monospace)",
	fontSize: 10.5,
	padding: "1px 4px",
	borderRadius: 4,
	backgroundColor: "var(--bg-tertiary)",
};
