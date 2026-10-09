import { type FormEvent, useState } from "react";
import { createRoom, savedName, saveName } from "../api";

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
			window.location.assign(`/room/${roomId}`);
		} catch (err) {
			setError(String(err));
			setBusy(false);
		}
	}

	return (
		<main className="card">
			<h1>MoQ Meeting</h1>
			<form onSubmit={onSubmit}>
				<label>
					Your name
					<input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
				</label>
				<button type="submit" disabled={busy || !name.trim()}>
					Create room
				</button>
			</form>
			{error && <p className="error">{error}</p>}
		</main>
	);
}
