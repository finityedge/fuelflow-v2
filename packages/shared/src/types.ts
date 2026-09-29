export enum UserRole {
  OWNER = 'OWNER',
  MANAGER = 'MANAGER',
  ATTENDANT = 'ATTENDANT',
}

export enum ShiftReportStatus {
  PENDING = 'PENDING',
  PARSED = 'PARSED',
  NEEDS_REVIEW = 'NEEDS_REVIEW',
  FAILED = 'FAILED',
}

/**
 * The three report states the review screen distinguishes. Declared as a string-literal
 * union rather than an enum so the frontend can compare against plain strings without
 * importing a runtime value — an enum's members are erased from the built output, which
 * is how a comparison against `ShiftReportStatus.PARSED` ends up comparing against
 * `undefined` in the browser.
 */
export type ShiftReportState = 'PENDING' | 'PARSED' | 'NEEDS_REVIEW' | 'FAILED';

/** How sure the parser is of one field. LOW means "a human should look at this". */
export type FieldConfidence = 'HIGH' | 'LOW';

/** The four areas the review screen groups extracted fields into. */
export type ExtractedFieldGroup =
  | 'CASH_PAYMENTS'
  | 'CREDIT_SALES'
  | 'ATTENDANT_RECONCILIATION'
  | 'TANK_READINGS';

/**
 * Note: nothing in this package is exported as a runtime value on purpose.
 * Both apps consume `@fuelflow/shared` for types only, so that neither build depends on
 * this package's compiled output being present at run time. Display labels live next to
 * the screens that render them.
 */

export interface Tenant {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Station {
  id: string;
  tenantId: string;
  name: string;
  location?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface User {
  id: string;
  tenantId: string;
  email: string;
  role: UserRole;
  stationIds?: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ShiftReport {
  id: string;
  tenantId: string;
  stationId: string;
  stationName?: string | null;
  /** Null until parsing reads it off the report. */
  reportDate?: string | null;
  status: ShiftReportState;
  pdfFileUrl?: string | null;
  pdfFileName?: string | null;
  uploadedAt: string;
  /** Set only when status is FAILED, and always phrased for a human. */
  failureReason?: string | null;
  parsedData?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractedField {
  id: string;
  shiftReportId: string;
  tenantId: string;
  fieldName: string;
  label: string;
  group: ExtractedFieldGroup;
  rawValue?: string | null;
  parsedValue?: string | null;
  amount?: number | null;
  confidence: FieldConfidence;
  needsReview: boolean;
  /** Why this field needs review, shown to the manager. */
  reviewNote?: string | null;
  /** The report text around this field, so a human can see what the parser saw. */
  regionText?: string | null;
  correctedAt?: string | null;
  correctedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The one number the review screen leads with:
 * pump totalizer sales - (cash + mobile money + approved credit).
 * Null when the pump totalizer figure could not be read, because a variance computed
 * from a missing input would be a confident lie.
 */
export interface ReconciliationSummary {
  pumpTotalizerSales: number | null;
  cash: number | null;
  mobileMoney: number;
  approvedCredit: number;
  variance: number | null;
  /** True while any contributing figure still needs review, so the variance may still move. */
  provisional: boolean;
}

/** A report plus everything the review screen needs to render it in one request. */
export interface ShiftReportDetail {
  report: ShiftReport;
  fields: ExtractedField[];
  summary: ReconciliationSummary;
  /** Count of fields still awaiting review — drives the "is anything wrong?" answer. */
  needsReviewCount: number;
}

/** One row of the recent-reports list. */
export interface ShiftReportListItem {
  id: string;
  stationId: string;
  stationName?: string | null;
  /**
   * The uploaded file's own name. A manager recognises their upload by this, not by the
   * report date — and for a failed parse the date was never read, so this is the only
   * thing that identifies the row at all.
   */
  fileName?: string | null;
  reportDate?: string | null;
  status: ShiftReportState;
  uploadedAt: string;
  failureReason?: string | null;
  needsReviewCount: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  email: string;
  role: UserRole;
  stationIds: string[];
}
