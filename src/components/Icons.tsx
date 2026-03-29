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

export function ChevronDown({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<path d="M6 9l6 6 6-6" />
		</svg>
	);
}

export function File({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
			<path d="M14 2v6h6" />
		</svg>
	);
}

export function FolderOpen({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v1" />
			<path d="M2 10l2.5 9h15l2.5-9H2z" />
		</svg>
	);
}

export function Image({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
			<circle cx="8.5" cy="8.5" r="1.5" />
			<path d="M21 15l-5-5L5 21" />
		</svg>
	);
}

export function Code({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
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

export function GitBranch({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<line x1="6" y1="3" x2="6" y2="15" />
			<circle cx="18" cy="6" r="3" />
			<circle cx="6" cy="18" r="3" />
			<path d="M18 9a9 9 0 01-9 9" />
		</svg>
	);
}

export function RefreshCw({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<path d="M21 2v6h-6" />
			<path d="M3 12a9 9 0 0115-6.7L21 8" />
			<path d="M3 22v-6h6" />
			<path d="M21 12a9 9 0 01-15 6.7L3 16" />
		</svg>
	);
}

export function ArrowLeft({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<line x1="19" y1="12" x2="5" y2="12" />
			<polyline points="12 19 5 12 12 5" />
		</svg>
	);
}

export function GitCompare({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<circle cx="18" cy="18" r="3" />
			<circle cx="6" cy="6" r="3" />
			<path d="M13 6h3a2 2 0 012 2v7" />
			<path d="M11 18H8a2 2 0 01-2-2V9" />
		</svg>
	);
}

export function PanelRight({ size, ...props }: IconProps) {
	return (
		<svg {...defaults(size)} {...props}>
			<rect x="3" y="3" width="18" height="18" rx="2" />
			<line x1="15" y1="3" x2="15" y2="21" />
		</svg>
	);
}
