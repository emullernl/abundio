import { useSettingsStore } from "../../stores/settingsStore";
import { ScrollbackControl } from "./NumberSteppers";
import { SectionLabel, ToggleRow } from "./primitives";
import { ShellPicker } from "./ShellPicker";

/** Everything that configures a terminal pane and its PTY. */
export function TerminalSection() {
	const gpuAccelerationEnabled = useSettingsStore(
		(s) => s.gpuAccelerationEnabled,
	);
	const setGpuAcceleration = useSettingsStore((s) => s.setGpuAcceleration);
	const smartImageDrop = useSettingsStore((s) => s.smartImageDrop);
	const setSmartImageDrop = useSettingsStore((s) => s.setSmartImageDrop);
	const terminalScrollback = useSettingsStore((s) => s.terminalScrollback);
	const setTerminalScrollback = useSettingsStore(
		(s) => s.setTerminalScrollback,
	);
	const debugActivityMeter = useSettingsStore((s) => s.debugActivityMeter);
	const toggleDebugActivityMeter = useSettingsStore(
		(s) => s.toggleDebugActivityMeter,
	);

	return (
		<div className="flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto">
			<div className="flex-shrink-0">
				<SectionLabel>GPU Acceleration</SectionLabel>
				<ToggleRow
					checked={gpuAccelerationEnabled}
					onChange={setGpuAcceleration}
					label="Render terminals on the GPU"
					description="Smoother scrolling and faster paint on heavy output. When many panes are open at once, some fall back to CPU rendering automatically."
				/>
			</div>
			<div className="flex-shrink-0">
				<SectionLabel>Scrollback Lines</SectionLabel>
				<ScrollbackControl
					value={terminalScrollback}
					onChange={setTerminalScrollback}
				/>
			</div>
			<div className="flex-shrink-0">
				<SectionLabel>Smart Image Drop</SectionLabel>
				<ToggleRow
					checked={smartImageDrop}
					onChange={setSmartImageDrop}
					label="Drop images to agents as images"
					description="When you drop an image onto a running agent, paste it via the clipboard so the agent recognises it — instead of inserting the file path. Other dropped files always insert their path."
				/>
			</div>
			<div className="flex flex-col flex-shrink-0" style={{ minHeight: 200 }}>
				<SectionLabel>Default Shell</SectionLabel>
				<p
					style={{
						fontSize: 12,
						color: "var(--fg-secondary)",
						marginBottom: 12,
						lineHeight: 1.5,
					}}
				>
					Choose the shell for new terminal panes. Existing panes are not
					affected.
				</p>
				<ShellPicker />
			</div>
			<div className="flex-shrink-0">
				<SectionLabel>Diagnostics</SectionLabel>
				<ToggleRow
					checked={debugActivityMeter}
					onChange={toggleDebugActivityMeter}
					label="Show terminal activity meter"
					description="Overlays a live byte-rate meter on every terminal pane, showing what Abundio's activity detection sees. Useful when an agent's status looks wrong. Also toggleable from the command palette."
				/>
			</div>
		</div>
	);
}
