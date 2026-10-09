import { type FormEvent, useState } from "react";
import { createRoom, savedName, saveName } from "../api";
import { Card } from "../components/Card";

export function Home() {
	const [name, setName] = useState(savedName);
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);

	async function onSubmit(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		try {
			saveName(name.trim());
			const { roomId } = await createRoom();
			window.location.assign(`/room/${roomId}${window.location.search}`);
		} catch (err) {
			setError(String(err));
			setBusy(false);
		}
	}

	return (
		<Card title="MoQ Meeting">
			<form onSubmit={onSubmit} className="grid gap-4">
				<label className="grid gap-1.5 text-sm text-muted">
					Your name
					<input
						className="field text-neutral-100"
						value={name}
						onChange={(e) => setName(e.target.value)}
						maxLength={40}
						required
					/>
				</label>
				<button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
					Create room
				</button>
			</form>
			{error && <p className="mt-4 text-sm text-bad">{error}</p>}
		</Card>
	);
}
