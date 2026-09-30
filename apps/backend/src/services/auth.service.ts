import { UserRole } from '@fuelflow/shared';
import { prisma } from '../prisma/client.js';
import { hashPassword, verifyPassword } from './password.service.js';
import { createAccessToken, createRefreshToken, type AccessTokenPayload } from './token.service.js';
import type { RegisterBody, LoginBody } from '../schemas/auth.schema.js';

export interface AuthResult {
  user: {
    id: string;
    tenantId: string;
    email: string;
    role: UserRole;
    stationIds: string[];
  };
  accessToken: string;
  refreshToken: string;
}

interface PrismaUserWithStations {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  stationAssignments: { stationId: string }[];
}

async function buildAuthResult(user: PrismaUserWithStations): Promise<AuthResult> {
  const stationIds = user.stationAssignments.map((assignment) => assignment.stationId);
  const role = user.role as UserRole;
  const payload: AccessTokenPayload = {
    sub: user.id,
    tenantId: user.tenantId,
    role: user.role,
    stationIds,
  };

  const accessToken = createAccessToken(payload);
  const { token: refreshToken } = await createRefreshToken(user.id);

  return {
    user: {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      role,
      stationIds,
    },
    accessToken,
    refreshToken,
  };
}

export async function registerTenantAndOwner(body: RegisterBody): Promise<AuthResult> {
  const passwordHash = await hashPassword(body.ownerPassword);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: body.tenantName },
      });

      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: body.ownerEmail,
          passwordHash,
          role: UserRole.OWNER,
        },
        include: { stationAssignments: true },
      });

      return user;
    });

    return buildAuthResult(result);
  } catch (error) {
    // `email` is unique table-wide, so a second registration with an address already in use
    // used to surface as a 500 and read as a broken server. It is an ordinary conflict, and
    // the transaction has already rolled the half-created tenant back.
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'P2002'
    ) {
      throw Object.assign(new Error('That email address is already registered.'), {
        statusCode: 409,
      });
    }
    throw error;
  }
}

export async function login(body: LoginBody): Promise<AuthResult | null> {
  const user = await prisma.user.findUnique({
    where: { email: body.email },
    include: { stationAssignments: true },
  });

  if (!user) {
    return null;
  }

  const valid = await verifyPassword(user.passwordHash, body.password);
  if (!valid) {
    return null;
  }

  // Same `null` as a wrong password, and the password is verified first so the reply takes
  // the same time either way. A distinct "this account is deactivated" would confirm to
  // anyone holding an old password that the address is real and was once valid.
  if (!user.isActive) {
    return null;
  }

  return buildAuthResult(user);
}

export async function refreshAccessToken(
  userId: string
): Promise<Omit<AuthResult, 'refreshToken'> | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { stationAssignments: true },
  });

  // Deactivating clears the stored refresh token, so this is the second line rather than the
  // only one: a token that was somehow captured before deactivation still cannot be traded
  // for a new access token.
  if (!user || !user.isActive) {
    return null;
  }

  const stationIds = user.stationAssignments.map((assignment) => assignment.stationId);
  const payload: AccessTokenPayload = {
    sub: user.id,
    tenantId: user.tenantId,
    role: user.role,
    stationIds,
  };

  return {
    user: {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role as UserRole,
      stationIds,
    },
    accessToken: createAccessToken(payload),
  };
}
