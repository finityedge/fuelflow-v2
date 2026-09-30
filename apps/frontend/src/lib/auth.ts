import { useAuthStore } from '../stores/authStore.js';
import { apiClient, API_BASE, readError } from './api.js';
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

/**
 * Ask for a reset link.
 *
 * Deliberately a bare `fetch` rather than `apiClient`, for a reason that is about this flow
 * specifically: `apiClient` retries a 401 after refreshing the access token, and a person
 * resetting a forgotten password has no session to refresh. Worse, the refresh failing calls
 * `clearAuthAndRedirect`, which would bounce them to `/login` in the middle of the one screen
 * that exists for people who cannot get past `/login`.
 *
 * Returns nothing, because the server says nothing. The endpoint answers identically for an
 * address with an account and one without, and a client that invented a difference — "we sent
 * it" versus "no such user" — would undo the whole point of that.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });

  if (!res.ok) {
    // The one refusal that is a property of the server rather than of the address: a deployment
    // with no working mail transport answers 503 rather than pretending.
    throw await readError(res, 'That request could not be sent.');
  }
}

/**
 * Spend a reset link and set a new password.
 *
 * No session comes back, and none is created locally: the caller has proved they hold the
 * account by producing the emailed link, which is not the same as having signed in. They go to
 * `/login` afterwards, the same way they would on any other device.
 */
export async function resetPassword(token: string, password: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password }),
  });

  if (!res.ok) {
    throw await readError(res, 'That password could not be set.');
  }
}
