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

/** `2026-03-12` -> `12 Mar 2026`. Falls back to the raw string if it is not a date. */
export function formatReportDate(value: string | null | undefined): string {
  if (!value) {
    return 'Date not read';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
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
