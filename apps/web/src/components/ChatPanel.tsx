import { type FormEvent, useEffect, useRef, useState } from "react";

export interface ChatEntry {
	/** `<participantId>:<id>`, unique across the room. */
	key: string;
	from: string;
	text: string;
	sentAt: number;
	mine: boolean;
}

interface Props {
	entries: ChatEntry[];
	nameOf: (participantId: string) => string;
	onSend: (text: string) => string | undefined;
	onClose: () => void;
}

const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** Room chat: everyone's logs merged by send time. Text is rendered as text, never HTML. */
export function ChatPanel({ entries, nameOf, onSend, onClose }: Props) {
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string>();
	const list = useRef<HTMLOListElement>(null);

	// Keep the newest message in view.
	const count = entries.length;
	useEffect(() => {
		if (count) list.current?.lastElementChild?.scrollIntoView({ block: "end" });
	}, [count]);

	function submit(e: FormEvent) {
		e.preventDefault();
		if (!draft.trim()) return;
		const err = onSend(draft);
		setError(err);
		if (!err) setDraft("");
	}

	return (
		<aside
			data-testid="chat"
			className="flex w-full flex-col border-line bg-surface max-md:fixed max-md:inset-0 max-md:z-10 md:w-80 md:border-l"
		>
			<div className="flex items-center justify-between border-b border-line px-4 py-3">
				<h2 className="text-sm font-semibold">Chat</h2>
				<button type="button" className="text-sm text-muted hover:text-neutral-100" onClick={onClose}>
					Close
				</button>
			</div>
			<ol ref={list} className="flex-1 space-y-3 overflow-y-auto px-4 py-3" data-testid="chat-messages">
				{entries.length === 0 && <li className="text-sm text-muted">No messages yet.</li>}
				{entries.map((m) => (
					<li key={m.key} className="text-sm" data-from={m.from}>
						<div className="flex items-baseline gap-2">
							<span className={`font-medium ${m.mine ? "text-accent" : ""}`}>{m.mine ? "You" : nameOf(m.from)}</span>
							<time className="text-xs text-muted" dateTime={new Date(m.sentAt).toISOString()}>
								{time.format(m.sentAt)}
							</time>
						</div>
						<p className="break-words whitespace-pre-wrap text-neutral-200">{m.text}</p>
					</li>
				))}
			</ol>
			<form onSubmit={submit} className="grid gap-2 border-t border-line p-3">
				<div className="flex gap-2">
					<input
						className="field"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						placeholder="Message everyone"
						maxLength={1000}
						data-testid="chat-input"
						aria-label="Chat message"
					/>
					<button type="submit" className="btn-primary" disabled={!draft.trim()}>
						Send
					</button>
				</div>
				{error && <p className="text-xs text-bad">{error}</p>}
			</form>
		</aside>
	);
}
