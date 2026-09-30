import { z } from 'zod';
import { UserRole } from '@fuelflow/shared';
import { booleanQueryParam } from './query.js';

/**
 * The roles an owner may hand out through the provisioning API.
 *
 * OWNER is excluded deliberately. This endpoint staffs a station — managers and attendants —
 * and it takes a password the caller chooses, so allowing OWNER here would make privilege
 * escalation a single request: anyone who could reach the route could mint a second full
 * owner. Adding a co-owner should be a deliberate act of its own, not one value in an enum.
 */
export const provisionableRoleSchema = z.enum([UserRole.MANAGER, UserRole.ATTENDANT]);

const emailSchema = z.string().email().max(255);

/**
 * Eight characters, matching `/auth/register`.
 *
 * There is no invite-by-email yet (that is item 0.7), so the owner types an initial password
 * for the person they are adding. The floor is the same one registration enforces, because a
 * second, weaker path into the same `User` table would quietly become the way in.
 */
const passwordSchema = z.string().min(8).max(255);

const stationIdsSchema = z.array(z.string().min(1).max(100)).max(200);

export const createUserBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  role: provisionableRoleSchema,
  /** Defaults to none: a manager of no station is a valid, if useless, starting state. */
  stationIds: stationIdsSchema.default([]),
});

export const updateUserBodySchema = z
  .object({
    role: provisionableRoleSchema.optional(),
    isActive: z.boolean().optional(),
    /** When present, replaces the whole assignment list rather than adding to it. */
    stationIds: stationIdsSchema.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one of role, isActive or stationIds.',
  });

/**
 * `includeInactive` arrives as the string `"true"`, and `z.coerce.boolean()` would answer
 * `true` for `"false"` as well — every non-empty string is truthy. Spelled out instead.
 */
export const listUsersQuerySchema = z.object({
  includeInactive: booleanQueryParam.optional(),
});

export type CreateUserBody = z.infer<typeof createUserBodySchema>;
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
