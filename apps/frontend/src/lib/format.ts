/**
 * Display formatting for shift reports.
 *
 * Every figure in this product is money a station is accountable for, so the rules are
 * fixed in one place: thousand separators always, the currency marked explicitly, and a
 * sign that is never left to be inferred from colour alone.
 */

const DECIMALS = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  // A figure that came off the report with cents keeps them; a round one stays round
  // rather than growing two zeros of false precision.
  maximumFractionDigits: 2,
});

/** `1234567` -> `1,234,567`. Returns an em dash for a figure that was never read. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return DECIMALS.format(value);
}

/** `1234567` -> `TZS 1,234,567`. */
export function formatTZS(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return `${value < 0 ? '-' : ''}TZS ${DECIMALS.format(Math.abs(value))}`;
}

/** `500` -> `+TZS 500`, `-500` -> `-TZS 500`, `0` -> `TZS 0`. */
export function formatSignedTZS(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  if (value === 0) {
    return 'TZS 0';
  }
  return `${value > 0 ? '+' : '-'}TZS ${DECIMALS.format(Math.abs(value))}`;
}

/**
 * A report's date, as a calendar day.
 *
 * A bare `2026-03-12` is read by `new Date` as UTC midnight, which is the *previous* day for
 * anyone west of Greenwich — the same shift would be filed under two different dates
 * depending on who opened it. Appending a local midnight keeps the day the parser read.
 * Timestamps are already unambiguous, so they are passed through as they are.
 */
function parseCalendarDay(value: string): Date | null {
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dayOnly ? `${value}T00:00:00` : value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** `2026-03-12` -> `12 Mar 2026`. Falls back to the raw string if it is not a date. */
export function formatReportDate(value: string | null | undefined): string {
  if (!value) {
    return 'Date not read';
  }
  const parsed = parseCalendarDay(value);
  if (!parsed) {
    return value;
  }
  return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const LONG_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
};

/**
 * `2026-03-12` -> `Thursday, 12 March 2026`.
 *
 * The review screen's own heading. A weekday is the wrong detail for a table of shifts and
 * the right one for a single shift a manager is checking against their memory of the day.
 */
export function formatReportDateLong(value: string | null | undefined): string {
  if (!value) {
    return 'Date not read';
  }
  const parsed = parseCalendarDay(value);
  if (!parsed) {
    return value;
  }
  return parsed.toLocaleDateString('en-GB', LONG_DATE_OPTIONS);
}

/** An ISO timestamp -> `12 Mar 2026, 14:05`. */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Bytes -> `1.2 MB`. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * An ISO timestamp -> `2 hours ago`.
 *
 * For scanning a list of uploads, "how long ago" is the useful question and the exact clock
 * time is not. Past a month the relative form stops carrying information ("47 days ago"), so
 * this hands back to the absolute formatter instead. Callers that need the precise moment
 * keep it in a `title` attribute — round-tripping through here loses it on purpose.
 */
export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) {
    return value;
  }

  const elapsed = Date.now() - then;

  // Covers small negative values too: a server clock a few seconds ahead of the browser
  // should read as "just now", not as a time in the future.
  if (elapsed < MINUTE_MS) {
    return 'just now';
  }
  if (elapsed < HOUR_MS) {
    const minutes = Math.floor(elapsed / MINUTE_MS);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  if (elapsed < 30 * DAY_MS) {
    const days = Math.floor(elapsed / DAY_MS);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  return formatTimestamp(value);
}

/**
 * `1234567` -> `1.2M`, `45000` -> `45k`.
 *
 * For chart axis ticks only. A tick reading `TZS 1,200,000` is wider than the plot area it
 * labels, and the unit is stated once in the axis title instead of on every tick. Never use
 * this for a figure a manager has to read exactly — that is `formatTZS`.
 */
export function formatCompactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  const magnitude = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (magnitude >= 1_000_000) {
    return `${sign}${(magnitude / 1_000_000).toFixed(magnitude >= 10_000_000 ? 0 : 1)}M`;
  }
  if (magnitude >= 1_000) {
    return `${sign}${(magnitude / 1_000).toFixed(magnitude >= 10_000 ? 0 : 1)}k`;
  }
  return `${sign}${Math.round(magnitude)}`;
}

/** `2026-09-29T...` -> `Tuesday, 29 September 2026`. */
export function formatLongDate(value: Date = new Date()): string {
  return value.toLocaleDateString('en-GB', LONG_DATE_OPTIONS);
}

/**
 * `2026-03-12` -> `12 Mar`. The x-axis of a 30-day chart has no room for the year, and
 * every point in the window is in the same one or two months.
 */
export function formatShortDate(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * `9` -> `Good morning`.
 *
 * Time-of-day greeting for the dashboard heading. Boundaries are the informal ones a person
 * would use, not solar noon: before midday is morning, before 17:00 afternoon, after that
 * evening.
 */
export function greetingFor(date: Date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) {
    return 'Good morning';
  }
  if (hour < 17) {
    return 'Good afternoon';
  }
  return 'Good evening';
}
