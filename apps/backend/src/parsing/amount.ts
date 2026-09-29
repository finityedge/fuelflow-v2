/**
 * Number handling for shift reports.
 *
 * Shift reports are typed by hand into a station system and printed, so the same figure
 * appears as `1,234,567`, `1 234 567`, `TZS 1234567`, `(1,234)` for a negative, or
 * `1,234-`. Everything here exists to turn those into one reliable number.
 */

export interface AmountMatch {
  /** The exact substring the number was read from. */
  raw: string;
  amount: number;
}

/**
 * Currency prefixes/suffixes that appear glued to figures. `/= ` is the common Tanzanian
 * shorthand for shillings.
 */
const CURRENCY_NOISE = /\b(TZS|TSH|TSh|Shs|shs|\/=)\b/gi;

/**
 * Candidate numeric substrings. Parenthesised (accounting-negative) form is listed first so
 * it wins over the bare-number alternative.
 */
const NUMBER_CANDIDATE =
  /\(-?\d[\d,\u00A0\u202F]*(?:\.\d+)?\)|-?\d[\d,\u00A0\u202F]*(?:\.\d+)?-?/g;

/** Strip currency words so `TZS 1,234` and `1,234 TZS` both reduce to a bare number. */
export function stripCurrencyNoise(text: string): string {
  return text.replace(CURRENCY_NOISE, ' ');
}

/**
 * Turn one numeric token into a number, or null if it is not a number at all.
 * Handles thousands separators (comma, space, non-breaking space, narrow no-break space),
 * accounting parentheses and trailing-minus negatives.
 */
export function parseAmount(raw: string): number | null {
  let t = raw.trim();
  if (!t) {
    return null;
  }

  let negative = false;

  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1).trim();
  }

  if (t.startsWith('-')) {
    negative = true;
    t = t.slice(1).trim();
  }

  if (t.endsWith('-')) {
    negative = true;
    t = t.slice(0, -1).trim();
  }

  // Drop thousands separators; the digit groups are only meaningful as a whole number.
  t = t.replace(/[\s\u00A0\u202F,]/g, '');

  if (!/^\d+(\.\d+)?$/.test(t)) {
    return null;
  }

  const value = Number(t);
  if (!Number.isFinite(value)) {
    return null;
  }

  return negative ? -value : value;
}

/**
 * Every number in a piece of text, in the order they appear.
 * Over-matching candidates are validated and discarded rather than truncated, so
 * `1,234,567.00` stays one match while stray punctuation yields nothing.
 */
export function findAmounts(text: string): AmountMatch[] {
  const cleaned = stripCurrencyNoise(text);
  const matches: AmountMatch[] = [];

  for (const candidate of cleaned.match(NUMBER_CANDIDATE) ?? []) {
    const amount = parseAmount(candidate);
    if (amount !== null) {
      matches.push({ raw: candidate.trim(), amount });
    }
  }

  return matches;
}

/** The first number at or after `fromIndex`, or null. */
export function firstAmountAfter(text: string, fromIndex: number): AmountMatch | null {
  return findAmounts(text.slice(fromIndex))[0] ?? null;
}

/** True when the text contains any digit — used to tell a data row from a heading. */
export function hasDigit(text: string): boolean {
  return /\d/.test(text);
}
