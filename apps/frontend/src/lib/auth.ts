import { useAuthStore } from '../stores/authStore.js';
import { apiClient } from './api.js';
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

export function logout(): void {
  useAuthStore.getState().clearAuth();
  window.location.href = '/login';
}
