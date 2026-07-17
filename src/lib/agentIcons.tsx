import { Bot } from "lucide-react";
import aiderIconUrl from "../assets/agent-icons/aider.ico";
import claudeIconUrl from "../assets/agent-icons/claude.svg";
import codexIconUrl from "../assets/agent-icons/codex.svg";
import geminiIconUrl from "../assets/agent-icons/gemini.svg";
import githubIconUrl from "../assets/agent-icons/github.svg";
import grokIconUrl from "../assets/agent-icons/grok.svg";
import kimiIconUrl from "../assets/agent-icons/kimi.svg";
import opencodeIconUrl from "../assets/agent-icons/opencode.svg";
import qwenIconUrl from "../assets/agent-icons/qwen.svg";
import terminalIconUrl from "../assets/agent-icons/terminal.jpg";

// Real brand assets pulled from each vendor's official site and bundled as
// Vite-hashed URLs. Rendered via <img> so the icons keep their authentic
// colors rather than inheriting currentColor from the parent.
//
// Sources:
//   - claude.ico       → anthropic.com
//   - github.svg       → github.githubassets.com (used for GitHub Copilot CLI)
//   - gemini.png       → ssl.gstatic.com (Google Gemini favicon)
//   - codex.svg        → developers.openai.com
//   - aider.ico        → aider.chat
//   - opencode.svg     → opencode.ai
//   - qwen.svg         → upload.wikimedia.org/wikipedia/commons/6/69/Qwen_logo.svg (CC0)
//   - kimi.svg         → moonshotai.github.io/Branding-Guide (k-only-dark: the
//                        official for-dark-backgrounds mark — white K + #1783FF
//                        accent; invisible-on-light is the same accepted
//                        limitation as codex.svg)
//   - grok.svg         → grok.com/images/favicon.svg (official product mark:
//                        white glyph on a near-black rounded tile — the tile
//                        is part of the asset, so it reads on light AND dark;
//                        decorative Figma foreignObject/drop-shadow stripped)
//   - terminal.jpg     → iterm2.com (for the "New Terminal" option)

interface IconProps {
	size?: number;
	className?: string;
	style?: React.CSSProperties;
}

function brandImg(src: string, title: string) {
	return function BrandImage({ size = 16, className, style }: IconProps) {
		return (
			<img
				src={src}
				alt={title}
				width={size}
				height={size}
				draggable={false}
				className={className}
				style={{
					display: "block",
					objectFit: "contain",
					...style,
				}}
			/>
		);
	};
}

const ClaudeIcon = brandImg(claudeIconUrl, "Claude");
const CopilotIcon = brandImg(githubIconUrl, "GitHub Copilot");
const GeminiIcon = brandImg(geminiIconUrl, "Google Gemini");
const CodexIcon = brandImg(codexIconUrl, "Codex");
const AiderIcon = brandImg(aiderIconUrl, "Aider");
const OpenCodeIcon = brandImg(opencodeIconUrl, "OpenCode");
const QwenIcon = brandImg(qwenIconUrl, "Qwen");
const KimiIcon = brandImg(kimiIconUrl, "Kimi");
const GrokIcon = brandImg(grokIconUrl, "Grok");

export const TerminalBrandIcon = brandImg(terminalIconUrl, "New Terminal");

/** Map an agent id to its brand icon component, or undefined if we should
 *  fall back to the generic Bot icon. Keyed by the agent `id` used in
 *  lib/agents.ts. */
export function getAgentIconComponent(
	agentId: string,
): React.ComponentType<IconProps> | undefined {
	switch (agentId) {
		case "claude":
			return ClaudeIcon;
		case "copilot":
			return CopilotIcon;
		case "gemini":
			return GeminiIcon;
		case "codex":
			return CodexIcon;
		case "aider":
			return AiderIcon;
		case "opencode":
			return OpenCodeIcon;
		case "qwen":
			return QwenIcon;
		case "kimi":
			return KimiIcon;
		case "grok":
			return GrokIcon;
		default:
			return undefined;
	}
}

export const FallbackAgentIcon = Bot;
