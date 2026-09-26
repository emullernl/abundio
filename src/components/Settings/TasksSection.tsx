import { useEffect, useState } from "react";
import {
	DEFAULT_ISSUE_TEMPLATE,
	DEFAULT_TASK_TEMPLATE,
	ISSUE_TEMPLATE_PLACEHOLDERS,
	resolveTaskPrompt,
	TASK_TEMPLATE_PLACEHOLDERS,
	type Task,
} from "../../lib/taskPrompt";
import { useSettingsStore } from "../../stores/settingsStore";
import {
	paramBodyInputStyle,
	secondaryButtonClass,
} from "../PromptActions/fieldStyles";
import { SectionLabel } from "./primitives";

const SAMPLE_TEXT: Task = {
	kind: "text",
	input: "The login page redirects to a 404 after sign-in.",
};
const SAMPLE_ISSUE: Task = {
	kind: "issue",
	issue: {
		number: 123,
		title: "Fix login redirect",
		url: "https://github.com/acme/app/issues/123",
	},
};

/**
 * One template editor. Edits stay local until blur, so typing does not write
 * localStorage and broadcast to every Window on each keystroke.
 */
function TemplateEditor({
	label,
	description,
	placeholders,
	value,
	defaultValue,
	onCommit,
	sample,
	templateKey,
}: {
	label: string;
	description: string;
	placeholders: readonly string[];
	value: string;
	defaultValue: string;
	onCommit: (v: string) => void;
	sample: Task;
	templateKey: "taskTemplate" | "issueTemplate";
}) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);

	const preview = resolveTaskPrompt(sample, {
		taskTemplate: DEFAULT_TASK_TEMPLATE,
		issueTemplate: DEFAULT_ISSUE_TEMPLATE,
		[templateKey]: draft,
	});

	return (
		<div>
			<div className="flex items-baseline justify-between gap-3">
				<SectionLabel>{label}</SectionLabel>
				<button
					type="button"
					className={`${secondaryButtonClass} rounded-md`}
					style={{ fontSize: 11, padding: "3px 8px" }}
					disabled={draft === defaultValue && value === defaultValue}
					onClick={() => {
						setDraft(defaultValue);
						onCommit(defaultValue);
					}}
				>
					Reset to default
				</button>
			</div>
			<p
				style={{
					fontSize: 12,
					color: "var(--fg-secondary)",
					marginBottom: 8,
					lineHeight: 1.5,
				}}
			>
				{description} Placeholders:{" "}
				{placeholders.map((p, i) => (
					<span key={p}>
						{i > 0 && ", "}
						<code style={{ fontFamily: "var(--font-mono)" }}>{`{{${p}}}`}</code>
					</span>
				))}
				.
			</p>
			<textarea
				value={draft}
				aria-label={label}
				rows={4}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => {
					if (draft !== value) onCommit(draft);
				}}
				className="rounded-md"
				style={{ ...paramBodyInputStyle, resize: "vertical" }}
			/>
			<div
				style={{
					fontSize: 11,
					color: "var(--fg-secondary)",
					marginTop: 8,
					marginBottom: 4,
				}}
			>
				Example of what the agent receives:
			</div>
			<pre
				className="rounded-md"
				style={{
					fontFamily: "var(--font-mono)",
					fontSize: 11.5,
					lineHeight: 1.5,
					whiteSpace: "pre-wrap",
					wordBreak: "break-word",
					color: "var(--fg-secondary)",
					backgroundColor: "var(--bg-tertiary)",
					padding: "8px 10px",
				}}
			>
				{preview}
			</pre>
		</div>
	);
}

export function TasksSection() {
	const taskTemplate = useSettingsStore((s) => s.taskTemplate);
	const issueTemplate = useSettingsStore((s) => s.issueTemplate);
	const setTaskTemplate = useSettingsStore((s) => s.setTaskTemplate);
	const setIssueTemplate = useSettingsStore((s) => s.setIssueTemplate);

	return (
		<div className="flex flex-col gap-6 flex-1 min-h-0 overflow-y-auto">
			<p
				style={{ fontSize: 12, color: "var(--fg-secondary)", lineHeight: 1.5 }}
			>
				New task starts an agent with a task as its first prompt. These
				templates wrap what you type, or the GitHub issue you pick, before it is
				sent. A note added in the New task dialog is appended after the
				template.
			</p>
			<TemplateEditor
				label="Task template"
				description="Wraps a task you describe in your own words."
				placeholders={TASK_TEMPLATE_PLACEHOLDERS}
				value={taskTemplate}
				defaultValue={DEFAULT_TASK_TEMPLATE}
				onCommit={setTaskTemplate}
				sample={SAMPLE_TEXT}
				templateKey="taskTemplate"
			/>
			<TemplateEditor
				label="Issue template"
				description="Wraps a GitHub issue picked in New task. Only the issue's number, title and link are sent — the agent reads the issue itself."
				placeholders={ISSUE_TEMPLATE_PLACEHOLDERS}
				value={issueTemplate}
				defaultValue={DEFAULT_ISSUE_TEMPLATE}
				onCommit={setIssueTemplate}
				sample={SAMPLE_ISSUE}
				templateKey="issueTemplate"
			/>
		</div>
	);
}
