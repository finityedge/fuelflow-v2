import { z } from 'zod';

/**
 * The attendant-profiling window.
 *
 * Matches the leakage screen's bound and for the same reason: an unbounded period would pull
 * every report the station has ever filed through the arithmetic on each page load, and a
 * month is the window a manager actually thinks in.
 */
export const attendantProfilesQuerySchema = z.object({
  stationId: z.string().min(1).max(100).optional(),
  periodDays: z.coerce.number().int().min(1).max(90).optional(),
});

/**
 * The window on a person's own record.
 *
 * The same bound as the profiling screen's, deliberately, and not merely for tidiness: an
 * attendant comparing their page against a manager's has to be able to ask for the same window,
 * or one of them is looking at a different set of shifts and the two cannot be reconciled.
 *
 * There is no `stationId` here although the profiling query has one. Which station answers this
 * is decided by the linked attendant record, so an id would be a parameter that either has to be
 * ignored or has to be checked against the record — and the first is confusing while the second
 * is a way to ask the question twice and answer it differently.
 */
export const myAttendantProfileQuerySchema = z.object({
  periodDays: z.coerce.number().int().min(1).max(90).optional(),
});

/**
 * The key to claim for an attendant.
 *
 * Accepts either the key directly or the printed name it comes from, because the two callers
 * have different things in hand: the unmapped list already holds the parser's key, while
 * somebody filling in a settings form has the spelling as it appears on the paper. Both
 * resolve to the same `slugify` output — see `parsing/slug.ts` — so neither can produce a key
 * the parser would never write.
 */
export const linkAttendantAliasBodySchema = z
  .object({
    slug: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[A-Z0-9]+(_[A-Z0-9]+)*$/, 'A key is uppercase letters, digits and underscores, e.g. J_MWANGI.')
      .optional(),
    name: z.string().trim().min(1).max(255).optional(),
  })
  .refine((body) => body.slug !== undefined || body.name !== undefined, {
    message: 'Provide the printed name, or the key the parser produces for it.',
  });

export type AttendantProfilesQuery = z.infer<typeof attendantProfilesQuerySchema>;
export type MyAttendantProfileQuery = z.infer<typeof myAttendantProfileQuerySchema>;
export type LinkAttendantAliasBody = z.infer<typeof linkAttendantAliasBodySchema>;
