import type { ApiError, CreateRoomResponse, TokenResponse } from "@moq-meeting/shared";

async function post<T>(path: string, body?: unknown): Promise<T> {
	const res = await fetch(path, {
		method: "POST",
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	const json = (await res.json()) as T | ApiError;
	if (!res.ok) throw new Error((json as ApiError).error ?? `HTTP ${res.status}`);
	return json as T;
}

export const createRoom = () => post<CreateRoomResponse>("/api/rooms");

export const joinRoom = (roomId: string, name: string) =>
	post<TokenResponse>(`/api/rooms/${encodeURIComponent(roomId)}/token`, { name });

const NAME_KEY = "moq-meeting:name";

export function savedName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? "";
	} catch {
		return "";
	}
}

export function saveName(name: string) {
	try {
		localStorage.setItem(NAME_KEY, name);
	} catch {
		// Private mode or blocked storage: the name just isn't remembered.
	}
}
