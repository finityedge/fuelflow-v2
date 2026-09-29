import type { AuthenticatedUser, AuthTokens } from '@fuelflow/shared';
import { useAuthStore } from '../stores/authStore.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api';

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
      const refreshToken = useAuthStore.getState().refreshToken;
      if (!refreshToken) {
        return null;
      }

      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });

        if (!res.ok) {
          return null;
        }

        const data = (await res.json()) as AuthTokens & { user: AuthenticatedUser };
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
