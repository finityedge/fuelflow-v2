import { z } from 'zod';

export const registerBodySchema = z.object({
  tenantName: z.string().min(1).max(255),
  ownerEmail: z.string().email().max(255),
  ownerPassword: z.string().min(8).max(255),
});

export const loginBodySchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1),
});

/**
 * The address to send a reset link to.
 *
 * Only the shape is checked. Whether the address belongs to anybody is a question this schema
 * must not answer — see `passwordReset.service.ts` for why the endpoint is uniform.
 */
export const forgotPasswordBodySchema = z.object({
  email: z.string().email().max(255),
});

/**
 * A token from an emailed link, and the password to replace the old one with.
 *
 * The minimum length is the same 8 as registration's, and it has to be: a reset is the other way
 * into an account, and a rule enforced on one door is not a rule.
 */
export const resetPasswordBodySchema = z.object({
  token: z.string().min(1).max(512),
  password: z.string().min(8).max(255),
});

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type ForgotPasswordBody = z.infer<typeof forgotPasswordBodySchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordBodySchema>;
