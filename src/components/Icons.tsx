import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function defaults(size = 16): SVGProps<SVGSVGElement> {
	return {
		width: size,
		height: size,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 2,
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
	};
}

export function ChevronLeft({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<path d="M15 18l-6-6 6-6" />
		</svg>
	);
}

export function ChevronRight({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<path d="M9 18l6-6-6-6" />
		</svg>
	);
}

export function Plus({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<path d="M12 5v14M5 12h14" />
		</svg>
	);
}

export function X({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<path d="M18 6L6 18M6 6l12 12" />
		</svg>
	);
}

export function Folder({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
		</svg>
	);
}

export function Terminal({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<path d="M4 17l6-5-6-5M12 19h8" />
		</svg>
	);
}

export function Grid({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<rect x="3" y="3" width="7" height="7" />
			<rect x="14" y="3" width="7" height="7" />
			<rect x="3" y="14" width="7" height="7" />
			<rect x="14" y="14" width="7" height="7" />
		</svg>
	);
}

export function Bot({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<path d="M12 8V4H8" />
			<rect x="4" y="8" width="16" height="12" rx="2" />
			<path d="M2 14h2M20 14h2M9 13v2M15 13v2" />
		</svg>
	);
}
