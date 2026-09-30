import type { SummaryInput } from './types.js';

/**
 * Reading a tank's wet-stock variance out of the fields the parser produced.
 *
 * The report prints, per tank, a book figure and a physical one:
 *
 *     TANK 1 PMS 12,000 11,500
 *
 * The parser stores those as `tank:TANK_1:book_stock` and `tank:TANK_1:closing_dip`. The
 * difference between them is the whole of Module 3, and it is deliberately derived here
 * rather than stored on the report, for the reason `computeSummary` is derived too: a manager
 * who corrects a misread dip has to see the leak number move. A stored column would go on
 * reporting the figure the parser got wrong the first time, and the correction screen would
 * be quietly lying about the tank.
 *
 * ## Which figure is which, and why the sign matters
 *
 * `book_stock` is what the station's paperwork says should be in the tank; `closing_dip` is
 * what the tape actually found. Book above dip means fuel that the paperwork believes in and
 * the tank does not contain, so the variance is **positive when fuel is missing**:
 *
 *     varianceLitres = bookStock - closingDip
 *
 * That matches the sign convention the money side already uses — positive variance is value
 * that left and was not accounted for — so "positive is bad" holds on both halves of the
 * screen. Getting this backwards would invert every conclusion drawn from it, which is why
 * it is stated here rather than left to be inferred from the subtraction.
 *
 * The assumption that `book_stock` is the closing book figure rather than an opening one is
 * read off the column pair the report prints and has not been checked against a station's own
 * paperwork; see the note in PLAN.md. If it turns out to be an opening figure the subtraction
 * becomes a two-report difference and the callers here do not change — only this function.
 */

/** The field-name prefix the parser writes for everything in the tank section. */
const TANK_PREFIX = 'tank:';

const BOOK_STOCK = 'book_stock';
const CLOSING_DIP = 'closing_dip';

export interface TankReading {
  /** The normalised key the parser produced, e.g. `TANK_1`. Matches `Tank.slug`. */
  slug: string;
  /** Litres the paperwork says should be there. Null when unreadable. */
  bookStock: number | null;
  /** Litres the tape found. Null when unreadable. */
  closingDip: number | null;
  /**
   * `bookStock - closingDip`, the litres the tank is short. Null unless both figures are
   * readable — an unreadable dip is not a zero, and treating it as one would invent a loss
   * the size of the book figure.
   */
  varianceLitres: number | null;
  /**
   * True while either contributing figure is still flagged, so this variance may still move.
   * A leak is an accusation about a named person's shift, and one made from a figure the
   * manager has not yet confirmed is worth labelling as provisional.
   */
  provisional: boolean;
}

/**
 * Split `tank:<slug>:<reading>` into its parts.
 *
 * The slug is `[A-Z0-9_]+` by construction (`slugify`), so it can never contain the delimiter
 * and a plain split is unambiguous. Anything that does not have exactly three parts is not a
 * reading this module understands, and is skipped rather than guessed at.
 */
function parseTankFieldName(fieldName: string): { slug: string; reading: string } | null {
  if (!fieldName.startsWith(TANK_PREFIX)) {
    return null;
  }

  const parts = fieldName.slice(TANK_PREFIX.length).split(':');
  if (parts.length !== 2) {
    return null;
  }

  const [slug, reading] = parts as [string, string];
  return slug.length > 0 ? { slug, reading } : null;
}

/**
 * Group a report's fields into one reading per tank.
 *
 * Returns them in the order the tanks appear on the report, so the screen reads in the same
 * order as the paper a manager has in front of them.
 */
export function tankReadingsFromFields(fields: SummaryInput[]): TankReading[] {
  /** Insertion-ordered, so the map's key order is the report's tank order. */
  const bySlug = new Map<string, { bookStock: SummaryInput | null; closingDip: SummaryInput | null }>();

  for (const field of fields) {
    const parsed = parseTankFieldName(field.fieldName);
    if (!parsed) {
      continue;
    }

    const entry = bySlug.get(parsed.slug) ?? { bookStock: null, closingDip: null };

    if (parsed.reading === BOOK_STOCK) {
      entry.bookStock = field;
    } else if (parsed.reading === CLOSING_DIP) {
      entry.closingDip = field;
    } else {
      // A reading this module does not know about — an opening dip, a delivery figure added
      // later. Leave it out rather than let it overwrite a field it is not.
      continue;
    }

    bySlug.set(parsed.slug, entry);
  }

  return [...bySlug.entries()].map(([slug, entry]) => {
    const bookStock = entry.bookStock?.amount ?? null;
    const closingDip = entry.closingDip?.amount ?? null;

    return {
      slug,
      bookStock,
      closingDip,
      varianceLitres: bookStock !== null && closingDip !== null ? bookStock - closingDip : null,
      provisional: Boolean(entry.bookStock?.needsReview) || Boolean(entry.closingDip?.needsReview),
    };
  });
}
