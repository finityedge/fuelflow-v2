import crypto from 'node:crypto';
import type { JWT } from '@fastify/jwt';
import { prisma } from '../prisma/client.js';

const ACCESS_TTL = '15m';
const REFRESH_TTL_DAYS = 7;

export interface AccessTokenPayload {
  sub: string;
  tenantId: string;
  role: string;
  stationIds: string[];
}

export interface RefreshTokenPayload {
  sub: string;
  version: number;
}

let jwtInstance: JWT | null = null;

export function setJwtInstance(instance: JWT) {
  jwtInstance = instance;
}

function ensureJwt(): JWT {
  if (!jwtInstance) {
    throw new Error('JWT instance has not been initialized');
  }
  return jwtInstance;
}

export function createAccessToken(payload: AccessTokenPayload): string {
  return ensureJwt().sign(payload, { expiresIn: ACCESS_TTL });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return ensureJwt().verify(token) as AccessTokenPayload;
}

export async function createRefreshToken(userId: string): Promise<{ token: string; hash: string }> {
  const token = crypto.randomBytes(64).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');

  await prisma.user.update({
    where: { id: userId },
    data: { refreshToken: hash },
  });

  return { token, hash };
}

export async function verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const user = await prisma.user.findFirst({ where: { refreshToken: hash } });

  if (!user) {
    throw new Error('Invalid refresh token');
  }

  return { sub: user.id, version: 1 };
}

export async function revokeRefreshToken(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { refreshToken: null },
  });
}

export function getRefreshCookieOptions(): {
  expires: Date;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
} {
  const expires = new Date();
  expires.setDate(expires.getDate() + REFRESH_TTL_DAYS);

  return {
    expires,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  };
}
