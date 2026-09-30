import { z } from 'zod';

/**
 * A correction body. The value is accepted as text rather than a number because the
 * manager types what they can see on the paper report, and parsing that text is the
 * same job the parser does — one code path, so a corrected figure behaves exactly like
 * an extracted one.
 */
export const correctFieldBodySchema = z.object({
  parsedValue: z.string().min(1).max(120),
  /**
   * Why the reviewer changed the figure. Optional, and deliberately so.
   *
   * Requiring it would put a text box in front of the common case — the parser read
   * `450000` as `45000` and the manager is fixing an obvious slip, where the value itself
   * is the explanation. But the corrections that matter most for an audit are the ones
   * that *removed* a variance, and those need a reason on the record. Optional means the
   * cheap fix stays cheap and the interesting one can still be documented.
   */
  note: z.string().trim().max(500).optional(),
});

/**
 * The statuses a list can be narrowed to.
 *
 * These are the report's own states and nothing else. A "balanced" filter is deliberately
 * absent even though it is the obvious thing to want: balance is a fact about the money,
 * `status` is a fact about whether a human is still needed, and the two disagree often
 * enough that a filter named after one and implemented with the other would lie. A report
 * whose every figure was read cleanly can still be 3,000,000 TZS short.
 */
export const LIST_STATUS_VALUES = ['PENDING', 'NEEDS_REVIEW', 'PARSED', 'FAILED'] as const;

/** An ISO calendar day, which is how a date range arrives from a date input. */
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD form');

export const listShiftReportsQuerySchema = z.object({
  stationId: z.string().min(1).max(100).optional(),
  status: z.enum(LIST_STATUS_VALUES).optional(),
  /** Inclusive, and compared against the report's date — see `listShiftReports`. */
  from: isoDay.optional(),
  to: isoDay.optional(),
  /** Which end of the list to start from. The review queue asks for `oldest`. */
  order: z.enum(['newest', 'oldest']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  /** How many matching reports to skip, for "load more". */
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

/** Accepted upload types. PDFs only: the parser reads a text layer, nothing else. */
export const ACCEPTED_UPLOAD_MIME = 'application/pdf';

/** 15 MB. A shift report is a few pages; anything larger is the wrong file. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export type CorrectFieldBody = z.infer<typeof correctFieldBodySchema>;
export type ListShiftReportsQuery = z.infer<typeof listShiftReportsQuerySchema>;
