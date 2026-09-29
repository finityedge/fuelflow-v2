import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AuthenticatedUser, AuthTokens } from '@fuelflow/shared';

interface AuthState {
  user: AuthenticatedUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  isHydrated: boolean;
  setAuth: (payload: { user: AuthenticatedUser } & AuthTokens) => void;
  setAccessToken: (accessToken: string) => void;
  clearAuth: () => void;
  setHydrated: (value: boolean) => void;
}

const STORAGE_KEY = 'fuelflow-auth';

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isHydrated: false,
      setAuth: ({ user, accessToken, refreshToken }) =>
        set({ user, accessToken, refreshToken }),
      setAccessToken: (accessToken) => set({ accessToken }),
      clearAuth: () =>
        set({ user: null, accessToken: null, refreshToken: null, isHydrated: true }),
      setHydrated: (value) => set({ isHydrated: value }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated(true);
      },
    }
  )
);

export function selectIsAuthenticated(state: AuthState): boolean {
  return Boolean(state.user && state.accessToken);
}

export function selectHasRole(state: AuthState, role: string): boolean {
  return state.user?.role === role;
}

export function selectHasAnyRole(state: AuthState, roles: string[]): boolean {
  return state.user ? roles.includes(state.user.role) : false;
}
