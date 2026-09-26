// Pure helpers for **New task**: turning a **Task** into the Agent's first
// prompt, naming its Tab, and suggesting a branch for an **Issue task**.
// See `CONTEXT.md` (Task, Issue task, Task template / Issue template).

import { stripControlChars } from "./promptActions";

export const DEFAULT_TASK_TEMPLATE = "{{input}}";

export const DEFAULT_ISSUE_TEMPLATE =
	"Start work on GitHub issue #{{number}} ({{url}}). When the whole issue is solved, ask me whether you may close it.";

/** The reference to a GitHub issue that an **Issue task** sends. Never the
 *  body: the Agent reads the issue itself. */
export interface IssueRef {
	number: number;
	title: string;
	url: string;
}

export type Task =
	| { kind: "text"; input: string; note?: string }
	| { kind: "issue"; issue: IssueRef; note?: string };

export interface TaskTemplates {
	taskTemplate: string;
	issueTemplate: string;
}

/**
 * The Agent's first prompt for `task`.
 *
 * Values (input, note, issue title/url) are stripped of control characters,
 * as a Prompt action's Parameter values are; the template is author-written
 * and is not. The free-text input is the one exception that keeps its
 * newlines — the user typed them into a multi-line field as part of the task,
 * and the prompt reaches the Agent as one argv element (ADR-0042), so a
 * newline cannot submit anything early.
 *
 * The note is appended after the resolved template as its own paragraph, not
 * interpolated: an empty note then leaves nothing behind.
 */
export function resolveTaskPrompt(
	task: Task,
	templates: TaskTemplates,
): string {
	const body =
		task.kind === "text"
			? fillTemplate(templates.taskTemplate, {
					input: stripKeepingNewlines(task.input.trim()),
				})
			: fillTemplate(templates.issueTemplate, {
					number: String(task.issue.number),
					title: stripControlChars(task.issue.title),
					url: stripControlChars(task.issue.url),
				});
	const note = stripKeepingNewlines(task.note?.trim() ?? "");
	return note ? `${body.trimEnd()}\n\n${note}` : body;
}

/**
 * Replace `{{name}}` placeholders (the Prompt action syntax) with `values`.
 * A placeholder with no value is left as written, so a typo in a template is
 * visible in the preview rather than silently vanishing. Not `resolveBody`:
 * that strips newlines out of every value, and the free-text input keeps its.
 */
function fillTemplate(
	template: string,
	values: Record<string, string>,
): string {
	// A Map, not `name in values`: `{{toString}}` must not find Object's own.
	const known = new Map(Object.entries(values));
	return template.replace(
		/\{\{([A-Za-z0-9_.-]+)\}\}/g,
		(whole, name: string) => known.get(name) ?? whole,
	);
}

/** Strip control characters but keep line breaks (normalised to `\n`). */
function stripKeepingNewlines(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map(stripControlChars)
		.join("\n");
}

const TAB_NAME_MAX = 30;

/** The Tab name for a Task: `#123 Fix login redirect`, or the start of the
 *  free text. Trimmed to one line and a short length with an ellipsis. */
export function taskTabName(task: Task): string {
	const raw =
		task.kind === "issue"
			? `#${task.issue.number} ${task.issue.title}`
			: task.input;
	const oneLine = stripControlChars(raw.replace(/\s+/g, " ").trim());
	if (oneLine.length <= TAB_NAME_MAX) return oneLine || "Task";
	return `${oneLine.slice(0, TAB_NAME_MAX - 1).trimEnd()}…`;
}

const BRANCH_SLUG_MAX = 40;

/**
 * The branch prefix an issue's labels call for: `fix/` for a `bug`, `feat/`
 * for an `enhancement` (matched case-insensitively), none otherwise. A bug
 * wins when an issue carries both.
 */
export function branchPrefixForLabels(labels: readonly string[]): string {
	const names = new Set(labels.map((l) => l.trim().toLowerCase()));
	if (names.has("bug")) return "fix/";
	if (names.has("enhancement")) return "feat/";
	return "";
}

/**
 * A branch name suggested for an Issue task: `issue-123-fix-login-redirect`,
 * prefixed by `branchPrefixForLabels` (`fix/issue-123-…`). Otherwise only
 * lowercase ASCII letters, digits and single dashes, so it always passes
 * `git check-ref-format`.
 */
export function suggestBranchForIssue(
	issue: IssueRef & { labels?: readonly string[] },
): string {
	const prefix = branchPrefixForLabels(issue.labels ?? []);
	const slug = issue.title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, BRANCH_SLUG_MAX)
		.replace(/-+$/g, "");
	const name = slug ? `issue-${issue.number}-${slug}` : `issue-${issue.number}`;
	return `${prefix}${name}`;
}

/** The placeholders each template offers, for the Settings legend. */
export const TASK_TEMPLATE_PLACEHOLDERS = ["input"] as const;
export const ISSUE_TEMPLATE_PLACEHOLDERS = ["number", "title", "url"] as const;
