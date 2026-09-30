/**
 * Deterministic template parser for Petronite fuel-station shift reports.
 *
 * The contract this file upholds, because the whole product depends on it:
 *
 *  - A field that cannot be matched does NOT fail the report. It is emitted with
 *    `needsReview: true`, `rawValue: null`, and the surrounding report text in
 *    `regionText` so a human can see what the parser saw.
 *  - Only a document that does not look like a Petronite shift report at all — or one
 *    from which nothing at all could be read — becomes FAILED.
 *  - Partial success becomes NEEDS_REVIEW. Partial success must never look identical
 *    to total failure.
 *  - Manual expense/discount entries always require review, however cleanly they parse,
 *    because they are precisely the unverifiable entries this product exists to catch.
 *
 * The parser is a pure function of the report text, which is what makes it testable
 * against sample text without needing real PDFs.
 */

import { findAmounts, firstAmountAfter, hasDigit, parseAmount } from './amount.js';
import { slugify } from './slug.js';
import type {
  ExtractedFieldGroup,
  ParsedField,
  ParseResult,
  ParseSummary,
  SummaryInput,
  TemplateDiagnostics,
} from './types.js';

/** Phrases that identify a Petronite shift report. Several must be present to accept a document. */
export const TEMPLATE_MARKERS: { name: string; pattern: RegExp }[] = [
  { name: 'PETRONITE', pattern: /\bPETRONITE\b/i },
  { name: 'SHIFT REPORT', pattern: /\bSHIFT\s+REPORT\b/i },
  { name: 'TOTALIZER', pattern: /\bTOTALIZER\b/i },
  { name: 'TANK DIP', pattern: /\b(DIP|TANK\s*DIP|DIPPING)\b/i },
  { name: 'ATTENDANT', pattern: /\bATTENDANT/i },
  { name: 'RECONCILIATION', pattern: /\bRECONCILIATION\b/i },
  { name: 'MOBILE MONEY', pattern: /\b(M-?PESA|TIGO\s*PESA|AIRTEL\s*MONEY|MOBILE\s*MONEY)\b/i },
  { name: 'CURRENCY TZS', pattern: /\bTZS\b/i },
];

/** How many distinct markers a document must show before we treat it as a shift report. */
export const REQUIRED_MARKER_COUNT = 3;

interface Line {
  text: string;
  /** Whitespace-collapsed text used for all matching. */
  flat: string;
  consumed: boolean;
}

interface ScalarSpec {
  fieldName: string;
  label: string;
  group: ExtractedFieldGroup;
  patterns: RegExp[];
}

/** Single-figure fields, matched by label anywhere in the document. */
const SCALAR_SPECS: ScalarSpec[] = [
  {
    fieldName: 'pump_totalizer_sales',
    label: 'Pump Totalizer Sales',
    group: 'CASH_PAYMENTS',
    patterns: [
      /\bTOTALIZER\s+(?:SALES|AMOUNT|TOTAL)\b/i,
      /\bPUMP\s+TOTALIZER\b/i,
      /\bTOTAL\s+SALES\b/i,
      /\bTOTALIZER\b/i,
    ],
  },
  {
    fieldName: 'cash_collected',
    label: 'Cash Collected',
    group: 'CASH_PAYMENTS',
    patterns: [/\bCASH\s+(?:COLLECTED|RECEIVED|SALES)\b/i, /\bCASH\b(?!\s*BACK)/i],
  },
  {
    fieldName: 'bank_deposit_total',
    label: 'Bank Deposits',
    group: 'CASH_PAYMENTS',
    patterns: [/\bBANK\s+DEPOSITS?\b/i, /\bDEPOSITS?\b/i],
  },
];

/**
 * A single mobile money figure, used only when the report does not itemise by provider.
 * Kept out of SCALAR_SPECS because a report that breaks the money out per provider would
 * otherwise also get a flag saying the combined total was missing.
 */
const MOBILE_MONEY_TOTAL_SPEC: ScalarSpec = {
  fieldName: 'mobile_money_collected',
  label: 'Mobile Money (total)',
  group: 'CASH_PAYMENTS',
  patterns: [/\bMOBILE\s+MONEY\s+(?:TOTAL|COLLECTED|SALES)\b/i, /\bMOBILE\s+MONEY\b/i],
};

/** Mobile money is itemised by provider where the report breaks it out. */
const MOBILE_MONEY_PROVIDERS: { key: string; label: string; pattern: RegExp }[] = [
  { key: 'M_PESA', label: 'M-Pesa', pattern: /\bM-?\s?PESA\b/i },
  { key: 'TIGO_PESA', label: 'Tigo Pesa', pattern: /\bTIGO\s*PESA\b/i },
  { key: 'AIRTEL_MONEY', label: 'Airtel Money', pattern: /\bAIRTEL\s*MONEY\b/i },
];

/** Section headers that open an itemised block. */
const SECTION_HEADERS = {
  credit: /\bCREDIT\s*(?:SALES?)?\b/i,
  attendant: /\bATTENDANTS?\b/i,
  tank: /\b(TANKS?|DIP|DIPPING)\b/i,
  adjustments: /\b(DISCOUNTS?|EXPENSES?|ADJUSTMENTS?|WRITE\s*-?\s*OFFS?)\b/i,
};

/**
 * Every heading that closes the block before it.
 *
 * A blank line is the natural separator on the printed page, but it does not survive text
 * extraction: lines are rebuilt from glyph positions, so an empty line — which has no
 * glyphs — is simply absent from the text the parser sees. A section that ended only at a
 * blank line therefore ran on into the *next* section on a real PDF, while passing happily
 * against a hand-written text fixture that had the blank line in it. The headings are the
 * boundary that exists in both.
 *
 * `adjustments` is in this list for the same reason in reverse: a discount row contains the
 * word that identifies it, so matching on the row also tells us where the previous section
 * had to have finished.
 */
const SECTION_BOUNDARIES: RegExp[] = [
  SECTION_HEADERS.credit,
  SECTION_HEADERS.attendant,
  SECTION_HEADERS.tank,
  SECTION_HEADERS.adjustments,
  /\bMOBILE\s+MONEY\b/i,
  /\bRECONCILIATION\b/i,
  /\b(TOTALIZER|BANK\s+DEPOSITS?|CASH\s+COLLECTED)\b/i,
];

/**
 * The boundaries that should close a section opened by `header`, which is every boundary
 * except its own.
 *
 * A section's own heading pattern also matches its data rows — the tank rule matches
 * `TANK 1 PMS 12,000 11,500` just as readily as it matches `TANK DIP` — so leaving it in
 * makes the section end on its own first row and yield nothing at all.
 */
function boundariesExcept(header: RegExp): RegExp[] {
  return SECTION_BOUNDARIES.filter((boundary) => boundary !== header);
}

/** Words that mark a manual entry which must always be reviewed. */
const ALWAYS_REVIEW_KEYWORDS = /\b(CASH\s*BACK|CASHBACK|DISCOUNT|EXPENSE|ADJUSTMENT|WAIVER|WRITE\s*-?\s*OFF)\b/i;

/**
 * A discount, expense or write-off is a manual entry. It is never a credit sale, never an
 * attendant's takings and never a tank reading.
 *
 * The itemised parsers skip these rows, which is what stops a section that overran — past a
 * heading we do not recognise — from inventing a tank called `CASHBACK` out of the
 * reconciliation note underneath it. The section-boundary rule should already have closed
 * the section there; this is the second line of defence, and the one that holds when a
 * report uses a heading nobody has seen yet.
 */
function isManualAdjustmentRow(flat: string): boolean {
  return ALWAYS_REVIEW_KEYWORDS.test(flat);
}

/**
 * A Tanzanian plate: an optional 1-3 letter region code, 2-4 digits, then up to three
 * letters. The leading letter count starts at one because `T 123 ABC` is the common
 * form and requiring two letters would miss it.
 */
const PLATE_PATTERN = /\b([A-Z]{1,3}[\s-]?\d{2,4}[\s-]?[A-Z]{0,3})\b/;

/** A tank row's identifier: `TANK 1`, `Tank A`, or a bare `1` on a dip table. */
const TANK_ID_PATTERN = /^(?:TANK\s*)?(?:NO\.?\s*)?([A-Za-z0-9]{1,12})\b/;

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // Typographic characters a PDF renders that the ASCII rules elsewhere do not match.
    // Written as escapes rather than as the characters themselves: they are invisible or
    // near-invisible in an editor, so a stray reformat could delete one and silently stop
    // the normalisation, turning "CASH COLLECTED" into a label nothing recognises.
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u00A0\u202F\u2007]/g, ' ');
}

/**
 * Blank lines are kept, not dropped.
 *
 * They are the section boundaries in a printed report, and they are what stops a
 * "Tank Dip" block from swallowing the reconciliation note printed underneath it.
 */
function buildLines(text: string): Line[] {
  return normalizeText(text)
    .split('\n')
    .map((raw) => ({ text: raw.trim(), flat: raw.replace(/\s+/g, ' ').trim(), consumed: false }));
}

function isBlank(line: Line | undefined): boolean {
  return !line || line.flat.length === 0;
}

function regionAround(lines: Line[], index: number): string {
  return lines
    .slice(Math.max(0, index - 1), index + 2)
    .map((line) => line.text)
    .join('\n');
}

function makeField(partial: Omit<ParsedField, 'rawValue' | 'parsedValue' | 'amount' | 'reviewNote'> &
  Partial<Pick<ParsedField, 'rawValue' | 'parsedValue' | 'amount' | 'reviewNote'>>): ParsedField {
  return {
    rawValue: null,
    parsedValue: null,
    amount: null,
    reviewNote: null,
    ...partial,
  };
}

/**
 * Read a labelled single figure.
 *
 * The value is looked for on the label's own line first (normal for a printed report,
 * where dot leaders separate label and figure). Only if that line carries no number do
 * we accept a bare number on the following line, and that is downgraded to LOW
 * confidence because it is a guess about layout.
 */
function readScalar(lines: Line[], spec: ScalarSpec): ParsedField {
  // Patterns are the outer loop so that a specific pattern is tried against the whole
  // document before a loose one is tried against any line. Scanning line-first would let
  // a bare heading such as "CASH" claim the field ahead of the "CASH COLLECTED 8,000,000"
  // row printed underneath it.
  for (const pattern of spec.patterns) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.consumed || isBlank(line)) {
        continue;
      }

      const match = pattern.exec(line.flat);
      if (!match) {
        continue;
      }

      line.consumed = true;
      const inline = firstAmountAfter(line.flat, match.index + match[0].length);

      if (inline) {
        return makeField({
          fieldName: spec.fieldName,
          label: spec.label,
          group: spec.group,
          rawValue: inline.raw,
          parsedValue: String(inline.amount),
          amount: inline.amount,
          confidence: 'HIGH',
          needsReview: false,
          regionText: regionAround(lines, i),
        });
      }

      // Fallback: a bare figure on the next line (e.g. label and value in separate cells).
      const next = lines[i + 1];
      if (next && !next.consumed && !/[A-Za-z]{3}/.test(next.flat) && hasDigit(next.flat)) {
        const carried = findAmounts(next.flat)[0];
        if (carried) {
          next.consumed = true;
          return makeField({
            fieldName: spec.fieldName,
            label: spec.label,
            group: spec.group,
            rawValue: carried.raw,
            parsedValue: String(carried.amount),
            amount: carried.amount,
            confidence: 'LOW',
            needsReview: true,
            reviewNote: 'Figure was read from the line below the label - please verify',
            regionText: regionAround(lines, i),
          });
        }
      }

      return makeField({
        fieldName: spec.fieldName,
        label: spec.label,
        group: spec.group,
        confidence: 'LOW',
        needsReview: true,
        reviewNote: 'Label found but no figure could be read next to it',
        regionText: regionAround(lines, i),
      });
    }
  }

  return makeField({
    fieldName: spec.fieldName,
    label: spec.label,
    group: spec.group,
    confidence: 'LOW',
    needsReview: true,
    reviewNote: 'Label not found anywhere in the report text',
    regionText: null,
  });
}

/**
 * Inclusive start, exclusive end: the lines belonging to a section opened by `header`.
 *
 * A section ends at the next section heading, or at a blank line where one survives. The
 * heading rule is the one that matters — see `SECTION_BOUNDARIES` for why the blank line
 * cannot be relied on. The scan starts at the header's own line, so the header that opened
 * the section never closes it.
 */
function findSectionRange(
  lines: Line[],
  header: RegExp,
  stopHeaders: RegExp[]
): { start: number; end: number } | null {
  for (let i = 0; i < lines.length; i += 1) {
    if (isBlank(lines[i]) || !header.test(lines[i].flat)) {
      continue;
    }
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (isBlank(lines[j]) || stopHeaders.some((stop) => stop.test(lines[j].flat))) {
        end = j;
        break;
      }
    }
    return { start: i + 1, end };
  }
  return null;
}

/** Remove a leading row identifier (tank number, attendant index) so it is not read as a figure. */
function stripLeadingIndex(text: string): string {
  return text.replace(/^(?:TANK\s*)?(?:NO\.?\s*)?(?:\d{1,2}|[A-Z])\b[\s.:-]*/i, '');
}

/**
 * Remove a leading row number from an attendant line, and nothing else.
 *
 * `stripLeadingIndex` also removes a single leading letter, which is right for a tank row and
 * wrong for this one. An attendant line very often begins with a person's initial, and eating
 * it collapsed `J. MWANGI` and `P. MWANGI` into the same key — `MWANGI` — so two people on one
 * station were merged into one profile and each inherited the other's shortfalls. That is the
 * exact harm the attendant-identity work exists to make impossible, arriving from the other
 * direction: not a similarity rule guessing two names are one person, but a stripper making
 * them the same string before anything could tell them apart. `slugify`'s own documentation
 * promises `J. Mwangi` becomes `J_MWANGI`, and this is what makes that true.
 *
 * A numbered attendant list is numbered with digits, so digits are all this removes.
 */
function stripLeadingAttendantIndex(text: string): string {
  return text.replace(/^(?:NO\.?\s*)?\d{1,2}\b[\s.:-]*/i, '');
}

function parseCreditSales(lines: Line[], range: { start: number; end: number }): ParsedField[] {
  const fields: ParsedField[] = [];
  let unidentified = 0;

  for (let i = range.start; i < range.end; i += 1) {
    const line = lines[i];
    if (line.consumed || !hasDigit(line.flat) || line.flat.length < 3 || isManualAdjustmentRow(line.flat)) {
      continue;
    }

    const plateMatch = PLATE_PATTERN.exec(line.flat.toUpperCase());
    if (plateMatch) {
      const amount = firstAmountAfter(line.flat, plateMatch.index + plateMatch[0].length);
      if (amount) {
        line.consumed = true;
        const plate = slugify(plateMatch[1]);
        fields.push(
          makeField({
            fieldName: `credit_sale:${plate}`,
            label: `Credit sale - ${plateMatch[1].toUpperCase()}`,
            group: 'CREDIT_SALES',
            rawValue: amount.raw,
            parsedValue: String(amount.amount),
            amount: amount.amount,
            confidence: 'HIGH',
            needsReview: false,
            regionText: line.text,
          })
        );
        continue;
      }
    }

    const amounts = findAmounts(line.flat);
    if (amounts.length > 0) {
      line.consumed = true;
      unidentified += 1;
      fields.push(
        makeField({
          fieldName: `credit_sale:unidentified_${unidentified}`,
          label: `Credit sale - vehicle not recognised (${unidentified})`,
          group: 'CREDIT_SALES',
          rawValue: amounts[0].raw,
          parsedValue: String(amounts[0].amount),
          amount: amounts[0].amount,
          confidence: 'LOW',
          needsReview: true,
          reviewNote: 'Could not read a vehicle plate number for this credit sale',
          regionText: line.text,
        })
      );
    }
  }

  return fields;
}

function parseAttendantRows(lines: Line[], range: { start: number; end: number }): ParsedField[] {
  const fields: ParsedField[] = [];

  for (let i = range.start; i < range.end; i += 1) {
    const line = lines[i];
    if (line.consumed || !hasDigit(line.flat) || isManualAdjustmentRow(line.flat)) {
      continue;
    }

    /*
     * The name and the amounts are read from the *same* string, so the two can never disagree
     * about where the name ended. Slicing `line.flat` by the length of a match made against the
     * stripped text took the offset from the wrong string: on a numbered row the name is found
     * several characters into the line and the slice landed back inside it.
     */
    const rowText = stripLeadingAttendantIndex(line.flat);
    const nameMatch = /^([A-Za-z][A-Za-z .'-]{2,40}?)(?=\s{2,}|\s+\d)/.exec(rowText);
    // Dot leaders are layout, not part of the name, and the lazy match absorbs them.
    const name = nameMatch ? nameMatch[1].replace(/[\s.]+$/, '').trim() : null;
    const slug = name ? slugify(name) : `attendant_${fields.length / 3 + 1}`;
    const amounts = findAmounts(nameMatch ? rowText.slice(nameMatch[0].length) : rowText);

    line.consumed = true;

    if (amounts.length < 2) {
      fields.push(
        makeField({
          fieldName: `attendant:${slug}:row`,
          label: `${name ?? 'Attendant'} - unreadable row`,
          group: 'ATTENDANT_RECONCILIATION',
          rawValue: amounts[0]?.raw ?? null,
          parsedValue: amounts[0] ? String(amounts[0].amount) : null,
          amount: amounts[0]?.amount ?? null,
          confidence: 'LOW',
          needsReview: true,
          reviewNote: 'Expected and collected figures could not both be read from this row',
          regionText: line.text,
        })
      );
      continue;
    }

    const expected = amounts[0].amount;
    const collected = amounts[1].amount;
    const variance = amounts[2]?.amount ?? expected - collected;
    const label = name ?? 'Attendant';

    fields.push(
      makeField({
        fieldName: `attendant:${slug}:expected`,
        label: `${label} - to collect`,
        group: 'ATTENDANT_RECONCILIATION',
        rawValue: amounts[0].raw,
        parsedValue: String(expected),
        amount: expected,
        confidence: 'HIGH',
        needsReview: false,
        regionText: line.text,
      }),
      makeField({
        fieldName: `attendant:${slug}:collected`,
        label: `${label} - collected`,
        group: 'ATTENDANT_RECONCILIATION',
        rawValue: amounts[1].raw,
        parsedValue: String(collected),
        amount: collected,
        confidence: 'HIGH',
        needsReview: false,
        regionText: line.text,
      }),
      makeField({
        fieldName: `attendant:${slug}:variance`,
        label: `${label} - variance`,
        group: 'ATTENDANT_RECONCILIATION',
        rawValue: amounts[2]?.raw ?? null,
        parsedValue: String(variance),
        amount: variance,
        confidence: amounts[2] ? 'HIGH' : 'LOW',
        // A variance the report did not print but which follows from the two figures that
        // were read is arithmetic, not a judgement call. Flagging it would put a row in
        // the manager's review queue every single shift and drown the rows that genuinely
        // need a human.
        needsReview: false,
        reviewNote: amounts[2] ? null : 'Calculated from the figures shown for this attendant',
        regionText: line.text,
      })
    );
  }

  return fields;
}

function parseTankRows(lines: Line[], range: { start: number; end: number }): ParsedField[] {
  const fields: ParsedField[] = [];

  for (let i = range.start; i < range.end; i += 1) {
    const line = lines[i];
    if (line.consumed || !hasDigit(line.flat) || isManualAdjustmentRow(line.flat)) {
      continue;
    }

    const remainder = stripLeadingIndex(line.flat);
    // Read the tank identifier from the identifier rule, not from the start of the line:
    // on `TANK 1 PMS 12,000 11,500` the first token is the literal word "TANK", which
    // would label every tank identically.
    const tankId = TANK_ID_PATTERN.exec(line.flat)?.[1] ?? String(fields.length / 2 + 1);
    const amounts = findAmounts(remainder);

    if (amounts.length === 0) {
      continue;
    }

    line.consumed = true;
    const tankSlug = slugify(tankId);
    const bookStock = amounts[0];
    const closingDip = amounts[1];

    fields.push(
      makeField({
        fieldName: `tank:${tankSlug}:book_stock`,
        label: `Tank ${tankId} - book stock`,
        group: 'TANK_READINGS',
        rawValue: bookStock.raw,
        parsedValue: String(bookStock.amount),
        amount: bookStock.amount,
        confidence: 'HIGH',
        needsReview: false,
        regionText: line.text,
      })
    );

    if (closingDip) {
      fields.push(
        makeField({
          fieldName: `tank:${tankSlug}:closing_dip`,
          label: `Tank ${tankId} - closing dip`,
          group: 'TANK_READINGS',
          rawValue: closingDip.raw,
          parsedValue: String(closingDip.amount),
          amount: closingDip.amount,
          confidence: 'HIGH',
          needsReview: false,
          regionText: line.text,
        })
      );
    } else {
      fields.push(
        makeField({
          fieldName: `tank:${tankSlug}:closing_dip`,
          label: `Tank ${tankId} - closing dip`,
          group: 'TANK_READINGS',
          confidence: 'LOW',
          needsReview: true,
          reviewNote: 'Closing dip reading not found for this tank',
          regionText: line.text,
        })
      );
    }
  }

  return fields;
}

/**
 * The readable name for a manual entry: the words in front of its figure.
 *
 * A row on the page reads `Cashback discount ....... 50,000`, and using the whole line as
 * the label put the dot leader and a second copy of the amount into the review list — on
 * the one screen where a manager has to scan labels to find what is asking for them. The
 * figure is already carried as the amount, so only the description before it is the name.
 *
 * The figures in these rows are matched with a local pattern rather than through
 * `findAmounts`, which reads a copy of the text with currency noise stripped out; the
 * offsets from that copy do not line up with the line as it was written.
 */
function adjustmentLabel(line: Line): string {
  const figure = /\d[\d,\u00A0\u202F]*/.exec(line.flat);
  const description = (figure ? line.flat.slice(0, figure.index) : line.flat)
    .replace(/[.…:;,\-_\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // A row that is nothing but a figure still has to have a name on the screen.
  return (description || 'Manual adjustment').slice(0, 60);
}

function parseAdjustments(lines: Line[], range: { start: number; end: number }): ParsedField[] {
  const fields: ParsedField[] = [];

  for (let i = range.start; i < range.end; i += 1) {
    const line = lines[i];
    if (line.consumed || !hasDigit(line.flat)) {
      continue;
    }

    const keyword = ALWAYS_REVIEW_KEYWORDS.exec(line.flat);
    const amount = findAmounts(line.flat)[0];
    if (!amount) {
      continue;
    }

    line.consumed = true;
    const descriptor = keyword ? keyword[0] : 'ADJUSTMENT';
    const slug = slugify(`${descriptor}_${fields.length + 1}`);

    fields.push(
      makeField({
        fieldName: `adjustment:${slug}`,
        label: adjustmentLabel(line),
        group: 'CASH_PAYMENTS',
        rawValue: amount.raw,
        parsedValue: String(amount.amount),
        amount: amount.amount,
        confidence: 'HIGH',
        // Manual entries are the ones this product exists to catch, so they are never
        // auto-accepted even when the figure itself parsed cleanly.
        needsReview: true,
        reviewNote: 'Manual expense/discount entries always require review',
        regionText: line.text,
      })
    );
  }

  return fields;
}

/**
 * Free-standing manual entries outside a dedicated section (a lone "cashback discount"
 * line, for example). Scanned last, over whatever no other rule claimed.
 */
function parseStrayAdjustments(lines: Line[]): ParsedField[] {
  const fields: ParsedField[] = [];

  for (const line of lines) {
    if (line.consumed || !ALWAYS_REVIEW_KEYWORDS.test(line.flat) || !hasDigit(line.flat)) {
      continue;
    }
    const amount = findAmounts(line.flat)[0];
    if (!amount) {
      continue;
    }

    line.consumed = true;
    // Named after what it is (`adjustment:CASHBACK_1`) rather than where it was found, so
    // the field list reads as a record of the shift rather than of the parser.
    const keyword = ALWAYS_REVIEW_KEYWORDS.exec(line.flat);
    const descriptor = keyword ? keyword[0] : 'ADJUSTMENT';

    fields.push(
      makeField({
        fieldName: `adjustment:${slugify(`${descriptor}_${fields.length + 1}`)}`,
        label: adjustmentLabel(line),
        group: 'CASH_PAYMENTS',
        rawValue: amount.raw,
        parsedValue: String(amount.amount),
        amount: amount.amount,
        confidence: 'HIGH',
        needsReview: true,
        reviewNote: 'Manual expense/discount entries always require review',
        regionText: line.text,
      })
    );
  }

  return fields;
}

/**
 * Mobile money, itemised by provider where the report does that and as one total where
 * it does not. Both shapes are normal; only one of them applies to any given report.
 */
function parseMobileMoney(lines: Line[]): ParsedField[] {
  const fields: ParsedField[] = [];

  for (const provider of MOBILE_MONEY_PROVIDERS) {
    const present = lines.some((line) => !line.consumed && provider.pattern.test(line.flat));
    if (!present) {
      continue;
    }

    fields.push(
      readScalar(lines, {
        fieldName: `mobile_money:${provider.key}`,
        label: provider.label,
        group: 'CASH_PAYMENTS',
        patterns: [provider.pattern],
      })
    );
  }

  if (fields.length > 0) {
    return fields;
  }

  const hasTotal = lines.some(
    (line) => !line.consumed && MOBILE_MONEY_TOTAL_SPEC.patterns[0].test(line.flat)
  );
  return hasTotal ? [readScalar(lines, MOBILE_MONEY_TOTAL_SPEC)] : [];
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Read the shift date off the report.
 *
 * Day-first ordering (12/03/2026 = 12 March) is the convention on these reports, so an
 * ambiguous numeric date is read as DD/MM/YYYY. Only an explicit day-first reading is
 * returned; if nothing matches, the caller stores null rather than inventing a date.
 */
export function parseReportDate(text: string): string | null {
  const flat = normalizeText(text);

  const labelled = /\b(?:SHIFT\s+)?DATE\b[^0-9A-Za-z]{0,12}([0-9A-Za-z ./-]{6,20})/i.exec(flat);
  const candidates = [labelled?.[1], flat].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(candidate);
    if (iso) {
      const parsed = isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
      if (parsed) {
        return parsed;
      }
    }

    const dmy = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(candidate);
    if (dmy) {
      const year = Number(dmy[3]) < 100 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
      const parsed = isoDate(year, Number(dmy[2]), Number(dmy[1]));
      if (parsed) {
        return parsed;
      }
    }

    const named = /\b(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s-]+(\d{4})\b/.exec(candidate);
    if (named) {
      const month = MONTHS[named[2].slice(0, 3).toLowerCase()];
      if (month) {
        const parsed = isoDate(Number(named[3]), month, Number(named[1]));
        if (parsed) {
          return parsed;
        }
      }
    }
  }

  return null;
}

function detectTemplate(lines: Line[]): TemplateDiagnostics {
  const haystack = lines.map((line) => line.flat).join('\n');
  const matchedMarkers: string[] = [];
  const missingMarkers: string[] = [];

  for (const marker of TEMPLATE_MARKERS) {
    if (marker.pattern.test(haystack)) {
      matchedMarkers.push(marker.name);
    } else {
      missingMarkers.push(marker.name);
    }
  }

  return { matchedMarkers, missingMarkers };
}

/**
 * The reconciliation figures, derived from the fields.
 *
 * Exported and used for both the initial parse and every later render, so a manager's
 * correction moves the headline variance through exactly the same arithmetic that
 * produced it in the first place.
 */
export function computeSummary(fields: SummaryInput[]): ParseSummary {
  const byName = new Map(fields.map((field) => [field.fieldName, field]));

  const scalarAmount = (name: string): number | null => byName.get(name)?.amount ?? null;

  const gradeTotalizers = fields.filter((f) => f.fieldName.startsWith('pump_totalizer_sales:'));
  const pumpTotalizerSales =
    scalarAmount('pump_totalizer_sales') ??
    (gradeTotalizers.length > 0
      ? gradeTotalizers.reduce((sum, f) => sum + (f.amount ?? 0), 0)
      : null);

  const cash = scalarAmount('cash_collected');

  const mobileFields = fields.filter((f) => f.fieldName.startsWith('mobile_money'));
  const mobileMoney = mobileFields.reduce((sum, f) => sum + (f.amount ?? 0), 0);

  const creditFields = fields.filter((f) => f.fieldName.startsWith('credit_sale:') && f.amount !== null);
  const approvedCredit = creditFields.reduce((sum, f) => sum + (f.amount ?? 0), 0);

  const contributors = [
    ...mobileFields,
    ...creditFields,
    byName.get('pump_totalizer_sales'),
    byName.get('cash_collected'),
  ].filter((field): field is SummaryInput => Boolean(field));

  const provisional = contributors.some((field) => field.needsReview);

  const variance =
    pumpTotalizerSales !== null && cash !== null
      ? pumpTotalizerSales - (cash + mobileMoney + approvedCredit)
      : null;

  return { pumpTotalizerSales, cash, mobileMoney, approvedCredit, variance, provisional };
}

function dedupeFieldNames(fields: ParsedField[]): ParsedField[] {
  const seen = new Map<string, number>();
  return fields.map((field) => {
    const count = seen.get(field.fieldName) ?? 0;
    seen.set(field.fieldName, count + 1);
    return count === 0 ? field : { ...field, fieldName: `${field.fieldName}_${count + 1}` };
  });
}

/**
 * Parse a shift report's text into fields, a reconciliation summary, and a status.
 * Never throws: a document it cannot understand comes back as FAILED with a reason.
 */
export function parseShiftReportText(rawText: string): ParseResult {
  const lines = buildLines(rawText);
  const diagnostics = detectTemplate(lines);
  // Read the date even on a failed report: knowing which shift a bad upload belongs to
  // is what lets a manager go back and re-upload the right file.
  const reportDate = parseReportDate(rawText);

  if (!lines.some((line) => !isBlank(line))) {
    return {
      status: 'FAILED',
      /*
       * The two causes of empty text are named, in the order they actually occur, because the
       * advice differs completely and the file itself cannot tell us which it is.
       *
       * A scan of a perfectly good report is the common case, and telling that manager their
       * file "may be corrupted" sends them to re-export a file that was never the problem.
       * What they need to know is that we read a digital PDF's text layer and cannot read a
       * picture — a real limitation of this product, stated as one rather than hedged.
       */
      failureReason:
        'No text could be read from this PDF. FuelFlow reads the text layer of a digital PDF and cannot read a scan or a photograph of a report — if this is one, upload the file the station exported instead. If this is the original file, it is damaged and needs exporting again.',
      fields: [],
      summary: emptySummary(),
      diagnostics,
      reportDate,
    };
  }

  if (diagnostics.matchedMarkers.length < REQUIRED_MARKER_COUNT) {
    return {
      status: 'FAILED',
      failureReason: `Document does not match the Petronite shift report template (found ${diagnostics.matchedMarkers.length} of ${REQUIRED_MARKER_COUNT} required markers: ${diagnostics.matchedMarkers.join(', ') || 'none'}).`,
      fields: [],
      summary: emptySummary(),
      diagnostics,
      reportDate,
    };
  }

  const fields: ParsedField[] = [];

  // Itemised sections first, so their rows are claimed before the scalar label scan and
  // a section header cannot be mistaken for a single-figure field.
  const creditRange = findSectionRange(lines, SECTION_HEADERS.credit, boundariesExcept(SECTION_HEADERS.credit));
  if (creditRange) {
    fields.push(...parseCreditSales(lines, creditRange));
  }

  const attendantRange = findSectionRange(lines, SECTION_HEADERS.attendant, boundariesExcept(SECTION_HEADERS.attendant));
  if (attendantRange) {
    fields.push(...parseAttendantRows(lines, attendantRange));
  }

  const tankRange = findSectionRange(lines, SECTION_HEADERS.tank, boundariesExcept(SECTION_HEADERS.tank));
  if (tankRange) {
    fields.push(...parseTankRows(lines, tankRange));
  }

  const adjustmentRange = findSectionRange(lines, SECTION_HEADERS.adjustments, boundariesExcept(SECTION_HEADERS.adjustments));
  if (adjustmentRange) {
    fields.push(...parseAdjustments(lines, adjustmentRange));
  }

  const mobileMoneyFields = parseMobileMoney(lines);
  fields.push(...mobileMoneyFields);

  if (mobileMoneyFields.length === 0 && diagnostics.matchedMarkers.includes('MOBILE MONEY')) {
    // The report plainly deals in mobile money but no figure came out of it. Silently
    // treating that as zero would overstate the variance and flag nothing, which is the
    // one failure mode this screen exists to prevent.
    fields.push(
      makeField({
        fieldName: 'mobile_money:unread',
        label: 'Mobile money collected',
        group: 'CASH_PAYMENTS',
        confidence: 'LOW',
        needsReview: true,
        reviewNote: 'The report mentions mobile money but no figure could be read for it',
        regionText: null,
      })
    );
  }

  for (const spec of SCALAR_SPECS) {
    fields.push(readScalar(lines, spec));
  }

  fields.push(...parseStrayAdjustments(lines));

  const uniqueFields = dedupeFieldNames(fields);
  const summary = computeSummary(uniqueFields);

  const coreReadable = SCALAR_SPECS.slice(0, 2).some((spec) =>
    uniqueFields.some((field) => field.fieldName === spec.fieldName && field.amount !== null)
  );
  const anyItemised = uniqueFields.some(
    (field) => field.group !== 'CASH_PAYMENTS' || field.fieldName.startsWith('mobile_money')
  );

  if (!coreReadable && !anyItemised) {
    return {
      status: 'FAILED',
      failureReason:
        'The document matched the Petronite template markers but no fields could be extracted from it. The layout may have changed.',
      fields: [],
      summary: emptySummary(),
      diagnostics,
      reportDate,
    };
  }

  const needsReview = uniqueFields.some((field) => field.needsReview);

  return {
    status: needsReview ? 'NEEDS_REVIEW' : 'PARSED',
    failureReason: null,
    fields: uniqueFields,
    summary,
    diagnostics,
    reportDate,
  };
}

function emptySummary(): ParseSummary {
  return {
    pumpTotalizerSales: null,
    cash: null,
    mobileMoney: 0,
    approvedCredit: 0,
    variance: null,
    provisional: true,
  };
}

/** Exposed for tests and for the correction endpoint, which re-uses amount parsing. */
export { parseAmount };
