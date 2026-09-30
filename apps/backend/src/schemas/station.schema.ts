import { z } from 'zod';
import { booleanQueryParam } from './query.js';

const nameSchema = z.string().trim().min(1).max(255);

/**
 * A slug as the parser produces one — see `parsing/slug.ts`.
 *
 * Constrained to that exact shape rather than accepted as free text, because a slug that does
 * not match what the parser derives is not a slug that will ever be matched. Catching it here
 * turns "this tank silently never appears in any report" into a 400 at the moment it is
 * created.
 */
const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Z0-9]+(_[A-Z0-9]+)*$/, 'A slug is uppercase letters, digits and underscores, e.g. TANK_1.');

const optionalText = z.string().trim().max(255).nullish();

/** Absolute TZS. Capped so a stray extra digit cannot make every shift in the tenant alert. */
const varianceThresholdSchema = z.number().finite().min(0).max(1_000_000_000);

export const createStationBodySchema = z.object({
  name: nameSchema,
  location: optionalText,
  varianceThreshold: varianceThresholdSchema.optional(),
});

export const updateStationBodySchema = z
  .object({
    name: nameSchema.optional(),
    location: optionalText,
    varianceThreshold: varianceThresholdSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one of name, location, varianceThreshold or isActive.',
  });

export const listStationsQuerySchema = z.object({
  includeInactive: booleanQueryParam.optional(),
});

/**
 * Litres of book-versus-dip shortfall on one shift worth alerting on.
 *
 * Capped at the largest tank we accept, so a figure typed in the wrong unit — 2000 meaning
 * 2,000 ml, or a stray extra digit — cannot silence every alert on the tank forever. Unlike
 * `varianceThresholdSchema` this one is a *lower* bound on what counts, so too large a value
 * is the dangerous direction: it turns the alert off rather than making it noisy.
 */
const leakThresholdLitresSchema = z.number().finite().positive().max(1_000_000);

export const createTankBodySchema = z.object({
  /**
   * The label as it is printed on the shift report, not a nickname. The parser only ever sees
   * the printed text, so this is the string its result has to match.
   */
  name: nameSchema,
  /** Derived from `name` when omitted. See `slugSchema`. */
  slug: slugSchema.optional(),
  product: z.string().trim().max(120).nullish(),
  capacityLitres: z.number().finite().positive().max(1_000_000).nullish(),
  leakThresholdLitres: leakThresholdLitresSchema.nullish(),
});

export const updateTankBodySchema = z
  .object({
    name: nameSchema.optional(),
    slug: slugSchema.optional(),
    product: z.string().trim().max(120).nullish(),
    capacityLitres: z.number().finite().positive().max(1_000_000).nullish(),
    leakThresholdLitres: leakThresholdLitresSchema.nullish(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update.',
  });

export const createAttendantBodySchema = z.object({
  /** The name as printed on the shift report. */
  name: nameSchema,
  slug: slugSchema.optional(),
  /** The login for this person, when they have one. */
  userId: z.string().uuid().nullish(),
});

export const updateAttendantBodySchema = z
  .object({
    name: nameSchema.optional(),
    slug: slugSchema.optional(),
    userId: z.string().uuid().nullish(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update.',
  });

export type CreateStationBody = z.infer<typeof createStationBodySchema>;
export type UpdateStationBody = z.infer<typeof updateStationBodySchema>;
export type ListStationsQuery = z.infer<typeof listStationsQuerySchema>;
export type CreateTankBody = z.infer<typeof createTankBodySchema>;
export type UpdateTankBody = z.infer<typeof updateTankBodySchema>;
export type CreateAttendantBody = z.infer<typeof createAttendantBodySchema>;
export type UpdateAttendantBody = z.infer<typeof updateAttendantBodySchema>;
