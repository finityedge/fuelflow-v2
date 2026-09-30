import { z } from 'zod';

/**
 * The findings-sheet window.
 *
 * `stationId` is required here and optional on the other three, which is the one intentional
 * difference in this schema. A findings sheet is a document about one forecourt; a sheet
 * assembled across a portfolio would have to pick a name for a heading, and whichever it picked
 * the totals underneath would belong to something else.
 *
 * The 90-day ceiling is the same quarter as every other screen's: a document that claims to
 * summarise a period has to be built from a bounded one, or the page load becomes the audit.
 */
export const findingsQuerySchema = z.object({
  stationId: z.string().min(1).max(100),
  periodDays: z.coerce.number().int().min(1).max(90).optional(),
});

export type FindingsQuery = z.infer<typeof findingsQuerySchema>;
