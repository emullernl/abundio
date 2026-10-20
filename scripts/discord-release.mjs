// Posts a published GitHub Release's notes to Discord as one embed.
// Run by .github/workflows/discord-release.yml:
//   DISCORD_WEBHOOK_URL=… node scripts/discord-release.mjs <release.json> <repo-url>
// <release.json> is the REST shape from `gh api repos/{repo}/releases/tags/{tag}`.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Discord's limits for one embed.
export const DESCRIPTION_LIMIT = 4096;
const TITLE_LIMIT = 256;

// The app's default accent (themes.ts).
const EMBED_COLOR = 0x58d5ba;

/**
 * Discord does not link `#123`, so point each one at the PR. GitHub
 * redirects /pull/N to the issue when N is an issue. Code spans and
 * existing links (`[#123](…)`, `page#123`) are left alone.
 */
export function linkifyPrRefs(markdown, repoUrl) {
	return markdown
		.split(/(`[^`]*`)/)
		.map((part, i) =>
			i % 2 === 1
				? part
				: part.replace(
						/(?<![\w/&[])#(\d+)\b/g,
						(_, n) => `[#${n}](${repoUrl}/pull/${n})`,
					),
		)
		.join("");
}

// A line that starts a new block, so cutting just before it never splits an item.
function startsBlock(line) {
	return line.trim() === "" || /^(#{1,6} |[-*] |\d+\. )/.test(line);
}

/**
 * Fit the notes into `limit` characters. Long notes are cut before the last
 * whole item that fits, and end with a link to the full notes.
 */
export function truncateNotes(markdown, releaseUrl, limit = DESCRIPTION_LIMIT) {
	if (markdown.length <= limit) return markdown;

	const suffix = `\n\n…[read the full notes](${releaseUrl})`;
	const budget = limit - suffix.length;
	const lines = markdown.split("\n");

	let kept = 0;
	let length = 0;
	for (let i = 0; i < lines.length; i++) {
		const next = length + (i > 0 ? 1 : 0) + lines[i].length;
		if (next > budget) break;
		length = next;
		if (i + 1 === lines.length || startsBlock(lines[i + 1])) kept = i + 1;
	}

	const head = lines.slice(0, kept);
	// Drop a heading or blank line left dangling at the cut.
	while (head.length > 0 && /^(#{1,6} .*|\s*)$/.test(head[head.length - 1])) {
		head.pop();
	}

	// No whole item fits: hard cut.
	const body =
		head.length > 0 ? head.join("\n") : markdown.slice(0, budget).trimEnd();
	return body + suffix;
}

export function buildPayload(release, repoUrl) {
	const title = (release.name || release.tag_name).slice(0, TITLE_LIMIT);
	const notes = linkifyPrRefs((release.body ?? "").trim(), repoUrl);
	return {
		embeds: [
			{
				title,
				url: release.html_url,
				description:
					truncateNotes(notes, release.html_url) || "No release notes.",
				color: EMBED_COLOR,
			},
		],
		// Never ping, whatever the notes contain.
		allowed_mentions: { parse: [] },
	};
}

async function main() {
	const [releaseFile, repoUrl] = process.argv.slice(2);
	const webhook = process.env.DISCORD_WEBHOOK_URL;
	if (!releaseFile || !repoUrl) {
		throw new Error(
			"usage: node scripts/discord-release.mjs <release.json> <repo-url>",
		);
	}
	if (!webhook) throw new Error("DISCORD_WEBHOOK_URL is not set");

	const release = JSON.parse(readFileSync(releaseFile, "utf8"));
	if (release.draft || release.prerelease) {
		console.log(`Skipping ${release.tag_name}: draft or prerelease.`);
		return;
	}

	const res = await fetch(`${webhook}?wait=true`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(buildPayload(release, repoUrl)),
	});
	if (!res.ok) {
		throw new Error(`Discord answered ${res.status}: ${await res.text()}`);
	}
	console.log(`Announced ${release.tag_name} on Discord.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((err) => {
		console.error(err.message);
		process.exit(1);
	});
}
