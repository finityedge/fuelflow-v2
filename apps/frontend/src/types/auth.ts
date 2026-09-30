import type { AuthenticatedUser } from '@fuelflow/shared';

export type AuthUser = AuthenticatedUser;

/** The server's answer to a successful login or registration. */
export interface AuthResponse {
  user: AuthUser;
  accessToken: string;
}
