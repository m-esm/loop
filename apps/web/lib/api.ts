export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:3001/api';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type Me = { id: string; kind: 'human' | 'agent'; displayName: string; email: string | null };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { ...init, cache: 'no-store', credentials: 'include' });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new ApiError(error?.message ?? `Request failed (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
}

export function actorLabel(name: string | null | undefined, principalId: string | null | undefined): string {
  if (!name) return 'unknown';
  return principalId ? name : `${name} (unverified)`;
}
