import { z } from 'zod';

/**
 * The leakage window.
 *
 * Wider than the dashboard's is not needed — a leak shows up over a quarter, and the same
 * 90-day ceiling applies for the same reason: an unbounded period would pull the station's
 * whole report history through the arithmetic on every page load.
 */
export const tankLeakageQuerySchema = z.object({
  stationId: z.string().min(1).max(100).optional(),
  periodDays: z.coerce.number().int().min(1).max(90).optional(),
});

export type TankLeakageQuery = z.infer<typeof tankLeakageQuerySchema>;
