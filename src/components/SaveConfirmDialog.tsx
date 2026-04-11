import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef } from "react";

interface SaveConfirmDialogProps {
	fileName: string;
	onSave: () => void;
	onDontSave: () => void;
	onCancel: () => void;
}

export function SaveConfirmDialog({
	fileName,
	onSave,
	onDontSave,
	onCancel,
}: SaveConfirmDialogProps) {
	const saveRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		saveRef.current?.focus();
	}, []);

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
				onClick={onCancel}
				onKeyDown={(e) => e.key === "Escape" && onCancel()}
			>
				<motion.div
					role="dialog"
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
					{/* Content */}
					<div className="flex flex-col items-center text-center px-8 pt-8 pb-6">
						<h2
							className="font-semibold mb-2"
							style={{ color: "var(--fg-primary)", fontSize: 16 }}
						>
							Save changes?
						</h2>
						<p
							className="leading-relaxed"
							style={{
								color: "var(--fg-secondary)",
								fontSize: 13,
								maxWidth: 320,
							}}
						>
							Do you want to save changes to &ldquo;{fileName}&rdquo;?
						</p>
					</div>

					{/* Actions */}
					<div
						className="flex flex-col gap-2 px-6 pb-6 pt-2"
						style={{
							borderTop: "1px solid var(--border)",
							backgroundColor:
								"color-mix(in srgb, var(--bg-primary) 40%, var(--bg-secondary))",
							padding: "20px 24px",
						}}
					>
						<button
							ref={saveRef}
							type="button"
							onClick={onSave}
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
							Save
						</button>
						<button
							type="button"
							onClick={onDontSave}
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
							Don&apos;t Save
						</button>
						<button
							type="button"
							onClick={onCancel}
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
							Cancel
						</button>
					</div>
				</motion.div>
			</motion.div>
		</AnimatePresence>
	);
}
