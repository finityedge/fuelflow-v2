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
  /**
   * Why the reviewer replaced the value, in their own words.
   *
   * The who and the when alone do not answer the question a station owner asks about a
   * correction that moved the variance — and a figure changed without a recorded reason is
   * indistinguishable from a figure changed to hide something.
   */
  correctionNote?: string | null;
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

/**
 * What the client receives when it authenticates.
 *
 * Only the access token. The refresh token is deliberately absent: the server keeps it in
 * an httpOnly cookie and a hashed copy in the database, and a refresh token the client can
 * read is one that ends up in `localStorage` where any script on the page can take it.
 */
export interface AuthSession {
  accessToken: string;
}

export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  email: string;
  role: UserRole;
  stationIds: string[];
}

/**
 * A user as the provisioning API returns them.
 *
 * `isActive` is a flag rather than a deletion — a deactivated attendant still authored the
 * corrections stamped with their id, and a list that dropped them would leave that history
 * pointing at nobody.
 */
export interface ManagedUser {
  id: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  stationIds: string[];
  createdAt: Date;
}

/**
 * A station as the settings screen lists it.
 *
 * `tankCount` and `attendantCount` ride along so the list can say how complete a station's set-up
 * is without a request per row. A station with no tanks cannot produce a wet-stock figure yet,
 * and the list is the place an owner would notice that.
 */
export interface StationSummary {
  id: string;
  name: string;
  location: string | null;
  isActive: boolean;
  /** Absolute TZS. 0 means every shift that does not balance exactly is over the threshold. */
  varianceThreshold: number;
  tankCount: number;
  attendantCount: number;
}

export interface TankSummary {
  id: string;
  name: string;
  /** The key matching the parser's `tank:<slug>:...` field names. */
  slug: string;
  product: string | null;
  capacityLitres: number | null;
  /**
   * Litres of single-shift shortfall worth alerting on. Null means the station has not set
   * one and the capacity fallback applies — see `thresholdLitres` on the leakage summary,
   * which reports the figure actually used rather than the figure stored.
   */
  leakThresholdLitres: number | null;
  isActive: boolean;
}

/**
 * A person named on shift reports, as a stable identity.
 *
 * Distinct from a login: most attendants never sign in, and the ones whose shortfalls matter
 * most are exactly the ones a manager files reports for.
 */
export interface AttendantSummary {
  id: string;
  name: string;
  /** The key matching the parser's `attendant:<slug>:...` field names. */
  slug: string;
  /**
   * Other keys on reports that belong to this person.
   *
   * The parser keys an attendant by the name as the report printed it, so "J. Mwangi" and
   * "John Mwangi" arrive as two different people until somebody says they are one. Each link
   * made here is one of those spellings, and every shift filed under it joins this person's
   * history.
   */
  aliases: string[];
  /** Set when this person also has a login. */
  userId: string | null;
  isActive: boolean;
}

/** A login with access to a station. */
export interface StationAccessUser {
  id: string;
  email: string;
  role: UserRole;
  isActive: boolean;
}

/**
 * Everything the station settings screen needs in one response.
 *
 * `attendants` and `users` are two different things and both are shown: the people whose names
 * appear on the reports, and the people who can sign in to this station. Collapsing them would
 * drop every attendant who has no login, which is most of them.
 */
export interface StationDetail {
  station: StationSummary;
  tanks: TankSummary[];
  attendants: AttendantSummary[];
  users: StationAccessUser[];
}

/* ------------------------------------------------------------------------------------------
 * Wet-stock leakage
 *
 * Fuel is the other half of what a station loses, and the money screen cannot see it: a shift
 * can balance perfectly in shillings and still have emptied a tank into somebody's jerrycan,
 * because the litres were sold and the cash banked. The only evidence is the tape against the
 * book, which is what this section carries.
 * ---------------------------------------------------------------------------------------- */

/**
 * Why a tank is being pointed at.
 *
 * Two signals, because a leak and a robbery look nothing alike in the data. A robbery is one
 * large shortfall; a leak is a small one repeated until the tank is dry, and no single shift
 * of it would ever be worth a phone call.
 */
export type TankLeakSignal =
  /** One shift came up short by more than the threshold. */
  | 'single_shift'
  /** Small shortfalls in the same direction, often enough and large enough to have added up. */
  | 'persistent_shortfall';

export interface TankLeakageAlert {
  signal: TankLeakSignal;
  /** The sentence to show, written for the reader rather than assembled from the numbers. */
  message: string;
  /** The shift that tripped a single-shift alert. Null for a persistent-shortfall alert. */
  reportId: string | null;
  /** ISO day of that shift. */
  date: string | null;
  /** Litres the alert is about: the one shift's shortfall, or the accumulated total. */
  litres: number;
}

/** One shift's book-versus-dip figure for one tank. */
export interface TankLeakagePoint {
  reportId: string;
  /** ISO day. */
  date: string;
  /** `book - dip`, so positive means litres that were on paper and not in the tank. */
  varianceLitres: number;
  /** A contributing reading is still flagged, so this point may move. */
  provisional: boolean;
}

export interface TankLeakageTank {
  /** Null when no `Tank` row claims this slug yet. */
  tankId: string | null;
  /** The `Tank`'s name, or the slug itself when nobody has named it. */
  name: string;
  slug: string;
  stationId: string;
  stationName: string | null;
  product: string | null;
  capacityLitres: number | null;
  /**
   * The threshold actually applied: the tank's own if it has one, otherwise the capacity
   * fallback. Null when neither is available, in which case a single shift alone never
   * alerts — reported as the figure used rather than the figure stored, so the screen never
   * has to re-derive it.
   */
  thresholdLitres: number | null;
  /** Sum of `book - dip` over the period. Positive: net fuel missing. */
  varianceLitres: number;
  /** The largest single-shift shortfall, as a positive number. Zero if never short. */
  worstShiftLitres: number;
  /** Shifts where both figures were readable, so a variance exists. */
  shifts: number;
  /** Of those, how many came up short. */
  shiftsShort: number;
  /** Shifts the tank appeared on where a figure was missing, so nothing could be compared. */
  shiftsNotComparable: number;
  /** Net variance as a share of capacity, when capacity is known. */
  capacityPercent: number | null;
  /** Any contributing reading still flagged. */
  provisional: boolean;
  alert: TankLeakageAlert | null;
  /** Oldest first. */
  trend: TankLeakagePoint[];
}

/**
 * A tank key that appeared on reports but that no `Tank` row answers to.
 *
 * These are not dropped. A station whose reports say `TANK_3` and whose settings only list
 * two tanks has a leak on a tank nobody has named, and the fix — add the tank in station
 * settings — is one the screen can ask for by name.
 */
export interface UnmappedTank {
  stationId: string;
  stationName: string | null;
  slug: string;
  shifts: number;
  varianceLitres: number;
}

export interface TankLeakageTotals {
  /** Tanks that could be compared on at least one shift. */
  tanks: number;
  /** Distinct shifts any tank figure was read from. */
  shiftsAnalysed: number;
  /** Net litres missing across every tank. Positive means fuel is going. */
  varianceLitres: number;
  /** Tanks net short over the period. */
  tanksShort: number;
  /** Tanks carrying an alert. */
  tanksAlerting: number;
}

export interface TankLeakageResponse {
  periodDays: number;
  generatedAt: string;
  stationId: string | null;
  /** Worst first: alerting tanks, then by litres missing. */
  tanks: TankLeakageTank[];
  unmapped: UnmappedTank[];
  totals: TankLeakageTotals;
}

/* ------------------------------------------------------------------------------------------
 * Attendant micro-loss profiling
 *
 * The other half of what a station loses. Cash variance is measured per shift and read per
 * shift, so a person who is consistently a little short looks exactly like a busy day: the
 * figure is small, it is inside the station's threshold, and it is gone by the time anyone
 * adds two of them together. This section is the adding-up.
 * ---------------------------------------------------------------------------------------- */

/**
 * Why an attendant is being pointed at.
 *
 * Three signals, because the ways money leaves are distinguishable and the response to each is
 * different. One large shortfall is a question for that shift. A run of small ones is a
 * question about the person. A drift upward from their *own* normal is a question about
 * whether something changed — and it is the one signal a station-wide threshold can never
 * raise, because it needs each person's baseline to compare against and not the station's.
 */
export type AttendantLossSignal =
  /** One shift came up short by at least the station's own materiality threshold. */
  | 'single_shift'
  /** Short on enough shifts, often enough, to be a pattern rather than a run of bad days. */
  | 'recurring_shortfall'
  /** Their recent shifts are materially worse than their own typical shift. */
  | 'worsening_drift';

export interface AttendantLossAlert {
  signal: AttendantLossSignal;
  /** The sentence to show, written for the reader rather than assembled from the numbers. */
  message: string;
  /** The shift that tripped a single-shift alert. Null for the other two signals. */
  reportId: string | null;
  /** ISO day of that shift. */
  date: string | null;
  /** The amount the alert is about: the one shift's shortfall, or the accumulated total. */
  amount: number;
}

/** One shift's reconciliation for one attendant. */
export interface AttendantVariancePoint {
  reportId: string;
  /** ISO day. */
  date: string;
  /** `expected - collected`, so positive means money that was due and not handed over. */
  variance: number;
  /** A contributing figure is still flagged, so this point may move. */
  provisional: boolean;
}

export interface AttendantProfile {
  /** Null when no `Attendant` row claims this slug yet. */
  attendantId: string | null;
  /** The `Attendant`'s name, or the slug itself when nobody has named them. */
  name: string;
  slug: string;
  stationId: string;
  stationName: string | null;
  /** Set when this person also has a login. */
  userId: string | null;
  /** Sum of `expected - collected` over the period. Positive: net money missing. */
  variance: number;
  /** The largest single-shift shortfall, as a positive number. Zero if never short. */
  worstShift: number;
  /** Shifts where both figures were readable, so a variance exists. */
  shifts: number;
  /** Of those, how many came up short. */
  shiftsShort: number;
  /** Shifts the attendant appeared on where a figure was missing, so nothing was compared. */
  shiftsNotComparable: number;
  /**
   * What they collected over the period, for scale. A TZS 5,000 variance means one thing on
   * TZS 50,000 of sales and another on TZS 50,000,000, and the shortfall alone does not say
   * which of those a person was working.
   */
  collected: number;
  /**
   * Their typical shift, as the median variance — not the mean, which one large shortfall
   * would define on its own. Null with no comparable shifts.
   */
  baselineVariance: number | null;
  /** Mean variance over their most recent comparable shifts. Null with none. */
  recentVariance: number | null;
  /** Any contributing reading still flagged. */
  provisional: boolean;
  alert: AttendantLossAlert | null;
  /** Oldest first. */
  trend: AttendantVariancePoint[];
}

/**
 * An attendant key that appeared on reports but that no `Attendant` row answers to.
 *
 * Kept rather than dropped, and for a sharper reason than tanks: a name printed on a report
 * that no one has claimed is exactly the case where a repeated shortfall has nowhere to be
 * recorded, so the money would otherwise leave no trace at all. The screen offers to link the
 * name to a known attendant.
 */
export interface UnmappedAttendant {
  stationId: string;
  stationName: string | null;
  slug: string;
  /** The name as the report printed it, when the parser could read one. */
  name: string | null;
  shifts: number;
  variance: number;
}

export interface AttendantProfileTotals {
  /** Attendants that could be compared on at least one shift. */
  attendants: number;
  /**
   * Distinct shifts that produced a comparable figure for an attendant with a record.
   *
   * Counted from the profiles themselves rather than from every report carrying an attendant
   * row, so it always matches the list beneath it. A shift whose only figures belong to an
   * unclaimed name is not in here — it is in `unmapped`, where it is visible as its own row.
   */
  shiftsAnalysed: number;
  /** Net money missing across every attendant. Positive means cash is going. */
  variance: number;
  /** Attendants net short over the period. */
  attendantsShort: number;
  /** Attendants carrying an alert. */
  attendantsAlerting: number;
  /** The materiality threshold the single-shift signal was judged against. */
  varianceThreshold: number;
}

export interface AttendantProfilesResponse {
  periodDays: number;
  generatedAt: string;
  stationId: string | null;
  /** Worst first: alerting attendants, then by money missing. */
  attendants: AttendantProfile[];
  unmapped: UnmappedAttendant[];
  totals: AttendantProfileTotals;
}

/**
 * One person's own record: the same figures a manager sees for them, asked for by the person
 * they are about.
 *
 * `linked` has to be sayable, and that is why this is not just an `AttendantProfile`. A login
 * with no attendant record is the ordinary state of an owner or a manager, and for an attendant
 * it means nobody has joined their account to the name on the reports yet. Answering an empty
 * profile to both cases would tell a real attendant that they have no shifts, when what has
 * happened is that their account was never linked — a screen that quietly says nothing is
 * wrong is worse than one that says what to fix.
 *
 * There is no station in the request, and that is deliberate: which station's reports answer
 * this is decided by the linked record, so there is no id to send and none to guess.
 */
export interface MyAttendantProfile {
  /** False when this login answers to no `Attendant` row. */
  linked: boolean;
  /**
   * The profile, or null when unlinked — or when the person had no comparable shift in the
   * window, which the two flags tell apart.
   */
  profile: AttendantProfile | null;
  periodDays: number;
  generatedAt: string;
  /**
   * The station's line for a single shift, so the screen can say what a shift was measured
   * against rather than leaving a bare figure to be read as a verdict. Zero when the station
   * has set no line of its own — the same meaning it has everywhere else: every shift that does
   * not balance exactly is worth showing.
   */
  varianceThreshold: number;
}

/* ------------------------------------------------------------------------------------------
 * Findings sheet
 *
 * The document the free audit hands over. Everything in it is already computed by the three
 * screens above — this section adds no arithmetic of its own, and that is the point: a sheet
 * that disagreed with the dashboard the owner was shown would be worse than no sheet.
 *
 * It is one station, deliberately. The document is about a place its owner can walk into, and
 * "TZS 1.2m unaccounted for across your three sites" is a different sentence from the one the
 * sales motion needs to make.
 * ---------------------------------------------------------------------------------------- */

/** One shift, as the sheet's evidence table lists it. Oldest first. */
export interface FindingsShiftRow {
  reportId: string;
  /** ISO day, or null when the parser could not read one — the upload date is not a shift date. */
  reportDate: string | null;
  /** Nullable because the column is: an upload that arrived without a name has none to print. */
  fileName: string | null;
  status: ShiftReportState;
  /** Null when the shift could not be reconciled at all. */
  variance: number | null;
  /** Figures on this shift still waiting on a human. */
  flaggedFields: number;
}

/** The money half of the sheet. */
export interface FindingsMoney {
  /** Reports inside the period, however they ended up. */
  reports: number;
  /** Of those, how many yielded a variance. */
  shiftsCompared: number;
  /** Sum of the short shifts. Positive. */
  unaccounted: number;
  /** Sum of the over-collected shifts, as a positive number. Kept apart from `unaccounted`. */
  overCollected: number;
  /** `unaccounted - overCollected`. What the period is net out by. */
  net: number;
  /** The single worst shift, by magnitude. */
  largest: {
    reportId: string;
    reportDate: string | null;
    fileName: string | null;
    variance: number;
  } | null;
  /** Figures across the period still waiting on a human. */
  flaggedFields: number;
  /** Reports that could not be read at all. */
  failedReports: number;
}

/**
 * The sentences at the top of the sheet.
 *
 * Built on the server from the same figures the rest of the document carries, rather than left
 * to the renderer, so the words and the numbers cannot come from two places. An audit that
 * found nothing says so in one of these, plainly — that is a finding too, and the one a
 * prospective customer is most entitled to hear.
 */
export interface FindingsSheet {
  station: {
    id: string;
    name: string;
    location: string | null;
    varianceThreshold: number;
  };
  periodDays: number;
  /** ISO day of the window's start and its end (today). */
  from: string;
  to: string;
  generatedAt: string;
  headlines: string[];
  /**
   * A figure somewhere in this document may still move — a corrected reading, or one the parser
   * flagged and nobody has checked yet. Stated once, at the top, rather than per row: a document
   * handed over as evidence has to say when it is not finished, and a sheet that reads as final
   * while a manager is still correcting it is the one way this page can do harm.
   */
  provisional: boolean;
  money: FindingsMoney;
  /** Oldest first. */
  shifts: FindingsShiftRow[];
  /** Worst first, already sorted by the profile service. */
  attendants: AttendantProfile[];
  tanks: TankLeakageTank[];
  totals: {
    attendants: AttendantProfileTotals;
    tanks: TankLeakageTotals;
  };
  /** Names on the reports that no record answers to, in both halves. */
  unattributed: {
    attendants: UnmappedAttendant[];
    tanks: UnmappedTank[];
  };
}

