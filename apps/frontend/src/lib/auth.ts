import { useAuthStore } from '../stores/authStore.js';
import { apiClient, API_BASE } from './api.js';
import type { AuthResponse } from '../types/auth.js';

interface RegisterPayload {
  tenantName: string;
  ownerEmail: string;
  ownerPassword: string;
}

interface LoginPayload {
  email: string;
  password: string;
}

export async function register(payload: RegisterPayload): Promise<AuthResponse> {
  const res = await apiClient('/auth/register', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(err.error ?? err.message ?? `Registration failed (${res.status})`);
  }

  const data = (await res.json()) as AuthResponse;
  useAuthStore.getState().setAuth(data);
  return data;
}

export async function login(payload: LoginPayload): Promise<AuthResponse> {
  const res = await apiClient('/auth/login', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(err.error ?? err.message ?? `Login failed (${res.status})`);
  }

  const data = (await res.json()) as AuthResponse;
  useAuthStore.getState().setAuth(data);
  return data;
}

/**
 * End the session on the server, then locally.
 *
 * Telling the server matters: the refresh token is httpOnly, so this app cannot delete it,
 * and until the server revokes it the cookie is a working session credential for anyone who
 * has a copy. A logout that only cleared local state left it live for its full seven days.
 *
 * Deliberately a bare `fetch` rather than `apiClient`: going through the client would try
 * to refresh an expired access token first, which is a strange thing to do on the way out.
 * The local session is cleared whatever the server says — a user who pressed sign out is
 * signed out here even if the network is down, and a cookie that outlives that is left to
 * expire rather than blocking the exit.
 */
export async function logout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch {
    // Offline, or the server is down. Clearing the local session still stands.
  } finally {
    useAuthStore.getState().clearAuth();
    window.location.href = '/login';
  }
}
