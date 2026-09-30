import { useAuthStore } from '../stores/authStore.js';
import type { AuthResponse } from '../types/auth.js';

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api';

/**
 * A request the server refused, carrying the server's own words.
 *
 * The message is the point. These screens are full of refusals that are only useful if the
 * reason survives the trip — "that key already belongs to Grace Kimaro" is a thing a person can
 * act on, and "the request failed" is not. The status is carried too, so a caller can tell a
 * refusal it caused from one it should offer to retry.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** The server's `{ error }` body when there is one, and the caller's own wording when there is not. */
export async function readError(res: Response, fallback: string): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: string };
    return new ApiError(res.status, body.error ?? fallback);
  } catch {
    return new ApiError(res.status, fallback);
  }
}

let refreshPromise: Promise<string | null> | null = null;

/** Exported for callers that cannot use apiClient — an XHR upload, for example. */
export function getAccessToken(): string | null {
  return useAuthStore.getState().accessToken;
}

function setAccessToken(accessToken: string): void {
  useAuthStore.getState().setAccessToken(accessToken);
}

function clearAuthAndRedirect(): void {
  useAuthStore.getState().clearAuth();
  if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
    window.location.href = '/login';
  }
}

async function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          // The refresh token is an httpOnly cookie, so it only travels when the request
          // asks for credentials. There is no body: the server reads the cookie, and a
          // client that has to send the token is a client that has to store it.
          credentials: 'include',
        });

        if (!res.ok) {
          return null;
        }

        const data = (await res.json()) as AuthResponse;
        useAuthStore.getState().setAuth(data);
        return data.accessToken;
      } finally {
        refreshPromise = null;
      }
    })();
  }

  return refreshPromise;
}

export async function apiClient(path: string, options: RequestInit = {}): Promise<Response> {
  const url = `${API_BASE}${path}`;
  const headers = new Headers(options.headers);

  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }

  const token = getAccessToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let res = await fetch(url, { ...options, headers });

  if (res.status === 401 && token) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      headers.set('Authorization', `Bearer ${newToken}`);
      setAccessToken(newToken);
      res = await fetch(url, { ...options, headers });
    } else {
      clearAuthAndRedirect();
    }
  }

  return res;
}
