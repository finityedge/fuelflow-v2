import { z } from 'zod';

/**
 * The dashboard window. Bounded at both ends: a period of 0 days has nothing in it, and a
 * period of years would pull the whole report history through the arithmetic on every
 * page load. 90 days is a quarter, which is as far back as a station owner reviews
 * shift-level variance.
 */
export const dashboardQuerySchema = z.object({
  stationId: z.string().min(1).max(100).optional(),
  periodDays: z.coerce.number().int().min(1).max(90).optional(),
});

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
