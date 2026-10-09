import type { ReactNode } from "react";

export function Card({ title, children }: { title: string; children: ReactNode }) {
	return (
		<main className="mx-auto mt-16 w-full max-w-md px-4">
			<div className="rounded-2xl border border-line bg-surface p-6 shadow-xl">
				<h1 className="mb-5 text-lg font-semibold">{title}</h1>
				{children}
			</div>
		</main>
	);
}
