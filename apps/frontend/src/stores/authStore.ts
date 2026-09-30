import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AuthenticatedUser } from '@fuelflow/shared';

interface AuthState {
  user: AuthenticatedUser | null;
  /**
   * The access token, and the only token this app ever holds.
   *
   * The refresh token is not here on purpose — it lives in an httpOnly cookie the server
   * sets and this app cannot read. That is what keeps a seven-day session credential out of
   * reach of any script running on the page. What remains here is the fifteen-minute access
   * token, which is the part that has to be readable to be sent as a header.
   */
  accessToken: string | null;
  isHydrated: boolean;
  setAuth: (payload: { user: AuthenticatedUser; accessToken: string }) => void;
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
      isHydrated: false,
      setAuth: ({ user, accessToken }) => set({ user, accessToken }),
      setAccessToken: (accessToken) => set({ accessToken }),
      clearAuth: () => set({ user: null, accessToken: null, isHydrated: true }),
      setHydrated: (value) => set({ isHydrated: value }),
    }),
    {
      name: STORAGE_KEY,
      // Bumped when the refresh token stopped being stored. Sessions persisted by the old
      // build still carry one in localStorage, and the migration below removes it — a
      // long-lived credential left behind in storage that nothing reads any more is
      // exactly the kind of thing an upgrade should clean up rather than preserve.
      version: 1,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted) => {
        if (persisted && typeof persisted === 'object') {
          delete (persisted as Record<string, unknown>).refreshToken;
        }
        return persisted as AuthState;
      },
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
