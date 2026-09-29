/**
 * Shared types for the deterministic shift-report parser.
 *
 * These are deliberately plain string-literal unions rather than Prisma enums so the
 * parser stays a pure function with no database or generated-client coupling. The
 * values match the Prisma enums (`FieldConfidence`, `ExtractedFieldGroup`) exactly,
 * so they can be handed straight to Prisma at the service boundary.
 */

export type FieldConfidence = 'HIGH' | 'LOW';

export type ExtractedFieldGroup =
  | 'CASH_PAYMENTS'
  | 'CREDIT_SALES'
  | 'ATTENDANT_RECONCILIATION'
  | 'TANK_READINGS';

export type ParseStatus = 'PARSED' | 'NEEDS_REVIEW' | 'FAILED';

/** A single field lifted out of the report, ready to be persisted as an ExtractedField. */
export interface ParsedField {
  /** Stable machine key, e.g. `cash_collected`, `credit_sale:T123ABC`, `tank:1:closing_dip`. */
  fieldName: string;
  /** Human label shown in the review screen. */
  label: string;
  group: ExtractedFieldGroup;
  /** The literal text the value was read from, kept for audit. Null when nothing matched. */
  rawValue: string | null;
  /** The normalised value as text. Null when nothing matched. */
  parsedValue: string | null;
  /** Numeric interpretation of the value, for arithmetic. Null for non-numeric fields. */
  amount: number | null;
  confidence: FieldConfidence;
  needsReview: boolean;
  /** Why the field needs review, shown to the manager. */
  reviewNote: string | null;
  /** The raw report text around this field, so a human can see what the parser saw. */
  regionText: string | null;
}

/** The one number a station manager cares about: pump sales minus everything accounted for. */
export interface ParseSummary {
  pumpTotalizerSales: number | null;
  cash: number | null;
  mobileMoney: number;
  approvedCredit: number;
  /** pumpTotalizerSales - (cash + mobileMoney + approvedCredit). Null when pump sales are unreadable. */
  variance: number | null;
  /** True when any contributing figure still needs review, so the variance may still move. */
  provisional: boolean;
}

export interface TemplateDiagnostics {
  matchedMarkers: string[];
  missingMarkers: string[];
}

export interface ParseResult {
  status: ParseStatus;
  /** Populated only when status is FAILED. */
  failureReason: string | null;
  fields: ParsedField[];
  summary: ParseSummary;
  diagnostics: TemplateDiagnostics;
  /** ISO-8601 date (YYYY-MM-DD) read off the report, or null when it could not be found. */
  reportDate: string | null;
}
