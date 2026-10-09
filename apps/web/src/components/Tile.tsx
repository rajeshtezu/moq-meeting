import type { ReactNode } from "react";

/** A 16:9 participant tile with a name label and optional stats overlay. */
export function Tile({
	label,
	badge,
	stats,
	children,
}: {
	label: string;
	badge?: string;
	stats?: string;
	children: ReactNode;
}) {
	return (
		<div className="relative aspect-video overflow-hidden rounded-xl border border-line bg-black">
			{children}
			<div className="absolute bottom-2 left-2 flex items-center gap-2 rounded-md bg-black/60 px-2 py-1 text-xs">
				<span className="font-medium">{label}</span>
				{badge && <span className="text-muted">{badge}</span>}
			</div>
			{stats && (
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
