import { GitBranch } from "../Icons";

export function NotAGitRepoEmpty() {
	return (
		<div className="flex flex-col items-center justify-center text-center px-6 gap-3 h-full">
			<div style={{ color: "var(--fg-secondary)", opacity: 0.4 }}>
				<GitBranch size={28} strokeWidth={1.5} />
			</div>
			<div>
				<div
					style={{
						color: "var(--fg-primary)",
						fontSize: 13,
						fontWeight: 500,
						marginBottom: 6,
					}}
				>
					Not a git repository
				</div>
				<div
					style={{
						color: "var(--fg-secondary)",
						fontSize: 12,
						lineHeight: 1.5,
						maxWidth: 200,
					}}
				>
					Initialize git to see changes and pull requests here.
				</div>
			</div>
		</div>
	);
}
