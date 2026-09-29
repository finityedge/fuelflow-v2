import { z } from 'zod';

/**
 * A correction body. The value is accepted as text rather than a number because the
 * manager types what they can see on the paper report, and parsing that text is the
 * same job the parser does — one code path, so a corrected figure behaves exactly like
 * an extracted one.
 */
export const correctFieldBodySchema = z.object({
  parsedValue: z.string().min(1).max(120),
});

export const listShiftReportsQuerySchema = z.object({
  stationId: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Accepted upload types. PDFs only: the parser reads a text layer, nothing else. */
export const ACCEPTED_UPLOAD_MIME = 'application/pdf';

/** 15 MB. A shift report is a few pages; anything larger is the wrong file. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export type CorrectFieldBody = z.infer<typeof correctFieldBodySchema>;
export type ListShiftReportsQuery = z.infer<typeof listShiftReportsQuerySchema>;
