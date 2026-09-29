import type { AuthenticatedUser, AuthTokens } from '@fuelflow/shared';

export type AuthUser = AuthenticatedUser;
export type { AuthTokens };

export interface AuthResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}
