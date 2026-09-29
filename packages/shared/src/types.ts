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

/** One row of the reports list. */
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
  /**
   * The row's reconciliation, carried on the row rather than fetched per report.
   *
   * The list and the dashboard's recent table both need it, and a list that has to ask
   * for each row's variance separately is a list that shows no variance at all. It is
   * computed from the same three columns in both places, so a row cannot come out with
   * one number in the table and another on the screen it links to.
   */
  summary: ReconciliationSummary;
}

/**
 * One row of the dashboard's recent-reports table.
 *
 * It is the list row, exactly — the variance moved onto `ShiftReportListItem` when the
 * reports list started showing it too, and an alias is kept so the dashboard's imports do
 * not have to change to say the same thing.
 */
export type DashboardReportRow = ShiftReportListItem;

/** A page of the reports list, with the count the filter matched. */
export interface ShiftReportListPage {
  reports: ShiftReportListItem[];
  /**
   * How many reports the filter matched in total, not how many are in `reports` — this is
   * what lets the list say "showing 25 of 63" instead of quietly stopping at 25.
   */
  total: number;
}

/** One point on the variance trend chart. */
export interface DashboardTrendPoint {
  reportId: string;
  /** Report date when the parser read one, otherwise the upload date. Always an ISO day. */
  date: string;
  variance: number;
  status: ShiftReportState;
  /** True while a contributing figure still needs review, so this point may still move. */
  provisional: boolean;
}

export interface DashboardTotals {
  reports: number;
  /** Parsed with nothing flagged. Not the same as the shift balancing. */
  readCleanly: number;
  /** Reports with at least one field waiting on a human. */
  needsReview: number;
  failed: number;
  pending: number;
  /** Individual fields flagged across every report in the period, not reports. */
  fieldsFlagged: number;
  /**
   * Reports that exist but whose shift date falls outside the window.
   *
   * The period is measured from the date printed on the report, not from when it was
   * uploaded, so a manager uploading a backlog of old paper reports gets a dashboard that
   * is legitimately empty. Without this count the screen would say "nothing here" to
   * someone who has just uploaded twelve of them, with nothing to explain why.
   */
  outsidePeriod: number;
}

/**
 * Variance is split by direction rather than netted to one figure.
 *
 * A shift that is 100,000 short and a shift that is 100,000 over sum to zero, so a single
 * "total variance" would report a month containing both as perfectly clean. That is the
 * single most misleading number this screen could show, so the two directions are kept
 * apart and the net is offered only alongside them.
 */
export interface DashboardVarianceTotals {
  /** Sum of the positive variances: money that left the pumps with nothing accounting for it. */
  unaccounted: number;
  /** Sum of the negative variances as a positive magnitude: more recorded than sold. */
  overCollected: number;
  /** `unaccounted - overCollected`. Shown as context, never as the headline. */
  net: number;
  /** How many reports in the period yielded a variance at all. */
  computed: number;
  /** How many could not: a figure was unreadable, so any variance would be a guess. */
  notComputed: number;
  largest: {
    reportId: string;
    reportDate: string | null;
    fileName: string | null;
    variance: number;
  } | null;
}

export interface DashboardSummary {
  periodDays: number;
  generatedAt: string;
  totals: DashboardTotals;
  variance: DashboardVarianceTotals;
  trend: DashboardTrendPoint[];
  recent: DashboardReportRow[];
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
