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

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
});

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type RefreshBody = z.infer<typeof refreshBodySchema>;
