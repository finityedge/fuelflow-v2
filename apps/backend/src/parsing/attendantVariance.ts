import type { SummaryInput } from './types.js';

/**
 * The columns this module reads.
 *
 * `SummaryInput` plus the label, and the label is the reason this is its own type rather than
 * a widening of `SummaryInput` itself: the tank arithmetic and the shift summary have no use
 * for a label, and widening the shared type would make every one of their queries fetch a
 * column it never reads. The label is here because a name no attendant has claimed is worth
 * showing a human as the report printed it — `J_MWANGI` is not something anyone recognises on
 * a list of people.
 */
export type AttendantFieldInput = SummaryInput & { label: string | null };

/**
 * Reading an attendant's cash variance out of the fields the parser produced.
 *
 * The report prints, per attendant, what they were due to hand over and what they handed over:
 *
 *     JOHN MWAKA ....... 3,200,000 3,150,000
 *
 * The parser stores those as `attendant:JOHN_MWAKA:expected` and
 * `attendant:JOHN_MWAKA:collected`. The gap between them is the whole of Module 2.
 *
 * ## Why this is derived rather than read from the report's own variance column
 *
 * The parser also writes an `attendant:<slug>:variance` field, and where the report prints a
 * variance column that is the figure it carries. This module does not read it, and the reason
 * is that it must agree with the correction screen: a manager who fixes a misread `collected`
 * figure has to see the attendant's profile move. Deriving from the two figures they can
 * correct keeps the profile, the shift summary and the screen arithmetically identical.
 *
 * The reported cost is that a station whose *printed* variance disagrees with the two figures
 * above it — a station-side arithmetic error — will not be reproduced here. That disagreement
 * is worth finding, but it is a finding about the station's paperwork and belongs on the shift
 * review screen, not silently propagated into a per-person total; this module states the rule
 * instead of picking a winner between two numbers it cannot adjudicate.
 *
 * ## The sign
 *
 *     variance = expected - collected
 *
 * Positive means money that was due and not handed over, matching the money convention
 * everywhere else in the product — positive variance is value that left and was not accounted
 * for. Getting this backwards would turn every profiled shortfall into a surplus, so it is
 * stated here rather than left to be read off the subtraction.
 */

/** The field-name prefix the parser writes for everything in the attendant section. */
const ATTENDANT_PREFIX = 'attendant:';

const EXPECTED = 'expected';
const COLLECTED = 'collected';

export interface AttendantReading {
  /** The normalised key the parser produced, e.g. `JOHN_MWAKA`. Matches `Attendant.slug`. */
  slug: string;
  /** What the attendant was due to hand over. Null when unreadable. */
  expected: number | null;
  /** What they handed over. Null when unreadable. */
  collected: number | null;
  /**
   * `expected - collected`, the money unaccounted for. Null unless both figures are readable —
   * an unreadable collected figure is not a zero, and treating it as one would invent a
   * shortfall the size of the whole day's takings.
   */
  variance: number | null;
  /**
   * True while either contributing figure is still flagged, so this variance may still move.
   * A repeated shortfall is a statement about a named person, and one drawn from a figure the
   * manager has not yet confirmed is worth labelling as provisional.
   */
  provisional: boolean;

  /**
   * The name the report printed, when the row carried one in its label.
   *
   * Carried so the screen can offer to link an unclaimed key to a known attendant using
   * something closer to what a human recognises than `J_MWANGI`. Not used for matching.
   */
  label: string | null;
}

/**
 * Split `attendant:<slug>:<reading>` into its parts.
 *
 * The slug is `[A-Z0-9_]` by construction (`slugify`), so it can never contain the delimiter
 * and a plain split is unambiguous. Anything without exactly three parts is not a reading this
 * module understands and is skipped rather than guessed at.
 */
function parseAttendantFieldName(fieldName: string): { slug: string; reading: string } | null {
  if (!fieldName.startsWith(ATTENDANT_PREFIX)) {
    return null;
  }

  const parts = fieldName.slice(ATTENDANT_PREFIX.length).split(':');
  if (parts.length !== 2) {
    return null;
  }

  const [slug, reading] = parts as [string, string];
  return slug.length > 0 ? { slug, reading } : null;
}

/**
 * The printed name out of a field label like `John Mwaka - to collect`.
 *
 * The parser writes the label as `<name> - <what it is>`, so the separator is the reliable
 * part. A label with no separator yields null rather than a guess at where the name stops — the
 * shape the parser used to write for a row it could not split, and which reports parsed before
 * that change still carry.
 */
function nameFromLabel(label: string | null | undefined): string | null {
  if (!label) {
    return null;
  }
  const separator = label.lastIndexOf(' - ');
  if (separator === -1) {
    return null;
  }
  const name = label.slice(0, separator).trim();
  return name.length > 0 ? name : null;
}

/**
 * Group a report's fields into one reading per attendant.
 *
 * Returns them in the order the attendants appear on the report, so the screen reads in the
 * same order as the paper a manager has in front of them.
 */
export function attendantReadingsFromFields(fields: AttendantFieldInput[]): AttendantReading[] {
  type Entry = {
    expected: AttendantFieldInput | null;
    collected: AttendantFieldInput | null;
    label: string | null;
  };

  /** Insertion-ordered, so the map's key order is the report's attendant order. */
  const bySlug = new Map<string, Entry>();

  for (const field of fields) {
    const parsed = parseAttendantFieldName(field.fieldName);
    if (!parsed) {
      continue;
    }

    const entry = bySlug.get(parsed.slug) ?? { expected: null, collected: null, label: null };

    if (parsed.reading === EXPECTED) {
      entry.expected = field;
      entry.label = entry.label ?? nameFromLabel(field.label);
    } else if (parsed.reading === COLLECTED) {
      entry.collected = field;
      // The collected label is the fallback source of the name; both rows carry it, and
      // preferring `expected` keeps the choice stable rather than dependent on field order.
      entry.label = entry.label ?? nameFromLabel(field.label);
    } else {
      // `variance` (see the note above), or a reading this module does not know about. Left
      // out rather than allowed to overwrite a field it is not.
      continue;
    }

    bySlug.set(parsed.slug, entry);
  }

  return [...bySlug.entries()].map(([slug, entry]) => {
    const expected = entry.expected?.amount ?? null;
    const collected = entry.collected?.amount ?? null;

    return {
      slug,
      expected,
      collected,
      variance: expected !== null && collected !== null ? expected - collected : null,
      provisional: Boolean(entry.expected?.needsReview) || Boolean(entry.collected?.needsReview),
      label: entry.label,
    };
  });
}
