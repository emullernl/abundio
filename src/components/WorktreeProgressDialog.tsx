import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { useEffect, useRef } from "react";
import type {
	WorktreeProgressDisplay,
	WorktreeVerb,
} from "../hooks/useWorktreeProgress";

interface WorktreeProgressDialogProps {
	verb: WorktreeVerb;
	/** Identifier shown in the message, e.g. a branch or a quoted name. */
	target: string;
	status: WorktreeProgressDisplay["status"];
	error?: string;
	/** Error state only — dismiss and return to the workspace. */
	onClose?: () => void;
	/** Error state, create only — reopen the form with the entered values. */
	onEdit?: () => void;
}

const VERB_ACTION: Record<WorktreeVerb, string> = {
	Creating: "create",
	Removing: "remove",
};

/**
 * Small waiting modal shown over the sidebar while a worktree is being created
 * or removed. In the `progress` state it's a non-cancelable indicator; on
 * failure it flips to an `error` state with Close (+ Edit for create). The bars
 * animate on the compositor (`will-change`) so they keep moving even through the
 * brief synchronous workspace mount that follows a create.
 */
export function WorktreeProgressDialog({
	verb,
	target,
	status,
	error,
	onClose,
	onEdit,
}: WorktreeProgressDialogProps) {
	const isError = status === "error";
	const primaryRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (isError) primaryRef.current?.focus();
	}, [isError]);

	return (
		<AnimatePresence>
			<motion.div
				role="presentation"
				className="fixed inset-0 z-[200] flex items-center justify-center"
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				exit={{ opacity: 0 }}
				transition={{ duration: 0.15 }}
				style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
				onClick={isError ? onClose : undefined}
				onKeyDown={(e) => {
					if (isError && e.key === "Escape") onClose?.();
				}}
			>
				<motion.div
					role="dialog"
					aria-label={`${verb} worktree`}
					className="rounded-2xl overflow-hidden flex flex-col"
					initial={{ opacity: 0, scale: 0.95, y: 10 }}
					animate={{ opacity: 1, scale: 1, y: 0 }}
					exit={{ opacity: 0, scale: 0.95, y: 10 }}
					transition={{ duration: 0.15, ease: [0.2, 0, 0, 1] }}
					style={{
						width: 420,
						backgroundColor: "var(--bg-secondary)",
						border: "1px solid var(--border)",
						boxShadow:
							"0 25px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset",
					}}
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
				>
					{isError ? (
						<>
							<div className="flex flex-col items-center text-center px-8 pt-8 pb-6">
								<div
									className="w-12 h-12 rounded-full flex items-center justify-center mb-5"
									style={{
										backgroundColor:
											"color-mix(in srgb, var(--error) 15%, transparent)",
										color: "var(--error)",
									}}
								>
									<AlertTriangle size={22} />
								</div>
								<h2
									className="font-semibold mb-2"
									style={{ color: "var(--fg-primary)", fontSize: 16 }}
								>
									Couldn't {VERB_ACTION[verb]} worktree
								</h2>
								<p
									className="leading-relaxed"
									style={{
										color: "var(--fg-secondary)",
										fontSize: 13,
										maxWidth: 320,
									}}
								>
									{error}
								</p>
							</div>
							<div
								className="flex flex-col gap-2"
								style={{
									borderTop: "1px solid var(--border)",
									backgroundColor:
										"color-mix(in srgb, var(--bg-primary) 40%, var(--bg-secondary))",
									padding: "20px 24px",
								}}
							>
								{onEdit && (
									<button
										ref={primaryRef}
										type="button"
										onClick={onEdit}
										className="w-full py-2.5 rounded-lg transition-all cursor-pointer font-medium"
										style={{
											fontSize: 13,
											color: "white",
											backgroundColor: "var(--accent)",
										}}
										onMouseEnter={(e) => {
											e.currentTarget.style.opacity = "0.85";
										}}
										onMouseLeave={(e) => {
											e.currentTarget.style.opacity = "1";
										}}
									>
										Edit & retry
									</button>
								)}
								<button
									ref={onEdit ? undefined : primaryRef}
									type="button"
									onClick={onClose}
									className="w-full py-2.5 rounded-lg transition-all cursor-pointer"
									style={{
										fontSize: 13,
										color: "var(--fg-secondary)",
										backgroundColor: "var(--bg-tertiary)",
									}}
									onMouseEnter={(e) => {
										e.currentTarget.style.color = "var(--fg-primary)";
									}}
									onMouseLeave={(e) => {
										e.currentTarget.style.color = "var(--fg-secondary)";
									}}
								>
									Close
								</button>
							</div>
						</>
					) : (
						<div
							className="flex flex-col items-center text-center"
							style={{ padding: "36px 32px 34px" }}
						>
							<div
								className="flex gap-[3px] mb-5"
								style={{ width: 27, height: 14 }}
							>
								{[0, 1, 2, 3, 4].map((i) => (
									<div
										key={i}
										style={{
											width: 3,
											height: 14,
											borderRadius: 1,
											backgroundColor: "var(--accent)",
											willChange: "transform, opacity",
											animation: `terminal-bar-wave 1.2s ease-in-out ${i * 0.12}s infinite`,
										}}
									/>
								))}
							</div>
							<p
								style={{
									color: "var(--fg-primary)",
									fontSize: 14,
									fontWeight: 500,
								}}
							>
								{verb} worktree{" "}
								<span
									style={{
										fontFamily:
											"var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
									}}
								>
									{target}
								</span>
								…
							</p>
						</div>
					)}
				</motion.div>
			</motion.div>
		</AnimatePresence>
	);
}
