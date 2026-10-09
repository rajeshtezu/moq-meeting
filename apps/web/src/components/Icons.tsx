/** Minimal stroke icons (24×24, currentColor). */
const base = {
	width: 18,
	height: 18,
	viewBox: "0 0 24 24",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 2,
	strokeLinecap: "round",
	strokeLinejoin: "round",
} as const;

export function MicIcon({ off = false }: { off?: boolean }) {
	return (
		<svg {...base} aria-hidden="true">
			<rect x="9" y="3" width="6" height="11" rx="3" />
			<path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
			{off && <path d="M4 4l16 16" />}
		</svg>
	);
}

export function CamIcon({ off = false }: { off?: boolean }) {
	return (
		<svg {...base} aria-hidden="true">
			<rect x="3" y="6" width="13" height="12" rx="2" />
			<path d="M16 10l5-3v10l-5-3" />
			{off && <path d="M3 3l18 18" />}
		</svg>
	);
}

export function ChatIcon() {
	return (
		<svg {...base} aria-hidden="true">
			<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
		</svg>
	);
}
