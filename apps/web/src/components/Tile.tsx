import type { ReactNode } from "react";
import { MicIcon } from "./Icons";

interface TileProps {
	label: string;
	badge?: string;
	stats?: string;
	speaking?: boolean;
	micOff?: boolean;
	/** Covers the video with an avatar (camera off, or no video yet). */
	camOff?: boolean;
	testId?: string;
	children: ReactNode;
}

function initials(name: string): string {
	return (
		name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((w) => w[0]?.toUpperCase())
			.join("") || "?"
	);
}

/** A 16:9 participant tile: video, name label, mic state, speaking ring, optional stats. */
export function Tile({ label, badge, stats, speaking, micOff, camOff, testId, children }: TileProps) {
	return (
		<div
			data-testid={testId}
			data-speaking={speaking ? "true" : "false"}
			data-mic={micOff ? "off" : "on"}
			data-cam={camOff ? "off" : "on"}
			className={`relative aspect-video overflow-hidden rounded-xl border bg-black transition-shadow ${speaking ? "border-ok shadow-[0_0_0_3px_var(--color-ok)]" : "border-line"}`}
		>
			{children}
			{camOff && (
				<div className="absolute inset-0 grid place-items-center bg-surface">
					<div className="grid size-20 place-items-center rounded-full bg-surface-2 text-2xl font-semibold text-muted">
						{initials(label)}
					</div>
				</div>
			)}
			<div className="absolute bottom-2 left-2 flex items-center gap-2 rounded-md bg-black/60 px-2 py-1 text-xs">
				{micOff && (
					<span className="text-bad" title="Muted">
						<MicIcon off />
					</span>
				)}
				<span className="font-medium" data-testid="name">
					{label}
				</span>
				{badge && <span className="text-muted">{badge}</span>}
			</div>
			{stats && !camOff && (
				<div
					className="absolute top-2 right-2 rounded-md bg-black/60 px-2 py-1 font-mono text-[11px] text-muted"
					data-testid="stats"
				>
					{stats}
				</div>
			)}
		</div>
	);
}
