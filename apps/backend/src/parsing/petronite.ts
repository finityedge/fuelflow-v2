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

/**
 * Phrases that identify a Petronite shift report. Several must be present to accept a document.
 *
 * The list was rebuilt around a real report rather than around the product spec, and the older
 * entries are kept because they are still printed — a Petronite export that carries a
 * `TOTALIZER SALES` line is a Petronite export whether or not it also carries a `Cash Position`
 * block. The additions are the headings the real document prints: `Pump Sales`,
 * `Stock Movement By Tank`, `Attendant Collection`, `Cash Position`.
 *
 * `ATTENDANT` is the one entry that is deliberately loose, and it is loose on purpose rather
 * than by oversight: it is a column heading on two unrelated tables of the real report
 * (`… Order Type Shift Attendant`), so it proves very little alone. It is kept because the
 * smallest attendant-only reports the suite builds reach exactly three markers and this is one
 * of them. What it costs is bounded by the threshold — three markers — and by nothing else in
 * this file treating the bare word as a section heading. See `SECTION_HEADERS`.
 */
export const TEMPLATE_MARKERS: { name: string; pattern: RegExp }[] = [
  { name: 'PETRONITE', pattern: /\bPETRONITE\b/i },
  { name: 'SHIFT REPORT', pattern: /\bSHIFT\s+REPORT\b/i },
  { name: 'TOTALIZER', pattern: /\bTOTALIZERS?\b/i },
  { name: 'TANK DIP', pattern: /\b(?:TANK\s*DIP|DIPPING)\b/i },
  { name: 'STOCK MOVEMENT', pattern: /\bSTOCK\s+MOVEMENT\s+BY\s+(?:TANK|PRODUCT)\b/i },
  { name: 'ATTENDANT', pattern: /\bATTENDANTS?\b/i },
  { name: 'ATTENDANT COLLECTION', pattern: /\bATTENDANT\s+COLLECTION\b/i },
  { name: 'PUMP SALES', pattern: /\bPUMP\s+SALES\b/i },
  { name: 'CASH POSITION', pattern: /\bCASH\s+POSITION\b/i },
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
    /*
     * `AMOUNT COLLECTED` comes first because the real report's cash position block prints both
     * it and `AMOUNT TO BE COLLECTED` on consecutive lines, and the looser `CASH …` patterns
     * below would otherwise reach the `Cash Sales` column heading on the pump table long before
     * either. Patterns are tried over the whole document in order (see `readScalar`), so the
     * order of this list is the difference between reading 4,040,200 and reading nothing.
     *
     * It is anchored to the start of the line for the same reason the section headings are: the
     * attendant table prints `… Amount To Collect  Amount Collected  Loss/Gain` as a column
     * heading thirty lines above the label it belongs to, and the unanchored form matched that
     * heading first. `CASH COLLECTED` below stays unanchored because the older layout prints it
     * behind dot leaders, which an anchor would reject.
     */
    patterns: [
      /^AMOUNT\s+COLLECTED\b/i,
      /\bCASH\s+(?:COLLECTED|RECEIVED|SALES)\b/i,
      /\bCASH\b(?!\s*BACK)/i,
    ],
  },
  {
    fieldName: 'bank_deposit_total',
    label: 'Bank Deposits',
    group: 'CASH_PAYMENTS',
    /*
     * The real report has no `BANK DEPOSIT` label. It prints the account and the money under a
     * `CASH TO BE BANKED` line: `NMB-<account>   160,000.00`. The middle pattern reads that by
     * its shape — a bank's short name, an account number, then the figure — because the account
     * number is the only thing on the line that says what it is. It is unanchored from any
     * label, so it is third in a list rather than first, and it requires four or more digits so
     * that a product row (`AGO - DIESEL 45,183.204 …`) cannot be read as a bank account.
     */
    patterns: [/\bBANK\s+DEPOSITS?\b/i, /^[A-Z]{2,8}[-\s]\d{4,}\b/, /\bDEPOSITS?\b/i],
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

/**
 * The headings that open an itemised block, and — by their presence here — the headings that
 * close the block before them.
 *
 * Every entry is anchored to the start of the line, and the anchoring is load-bearing rather
 * than tidiness. On a real report these words also appear as *column headings* on tables that
 * have nothing to do with the block named: `Shift Attendant` is printed above the Product &
 * Services tables, thirty lines before the `Attendant Collection` block, and `Returned To Tank
 * (RTT)` is printed above the pump test. An unanchored `/\bATTENDANTS?\b/` opened the attendant
 * block at that column heading; the block then ran until something else closed it and took the
 * Cash Sales product table as its rows, filing `AGO - DIESEL` and `PMS / MSP - PETROL` as
 * attendants' names — with their litres sold as the expected collection, their unit price as
 * the amount collected, and their money as a variance. It was high confidence and unflagged,
 * and the three people who actually appear on the report were never read at all.
 *
 * A heading only ever opens a block when the whole line is that heading (`PUMP SALES`), never
 * when it merely contains the words (`… Pump Side Price Amount`). That is the rule this
 * anchoring states, and it is what makes the block boundaries trustworthy enough to derive
 * money figures from.
 */
const SECTION_HEADERS = {
  pumpSales: /^PUMP\s+SALES\b/i,
  pumpTest: /^PUMP\s+TEST\b/i,
  credit: /^(?:NOZZLE\s+)?CREDIT\s+SALES\b/i,
  loyalty: /^LOYALTY\s+SALES\b/i,
  directSales: /^PRODUCTS?\s*&\s*SERVICES\b/i,
  cashSales: /^CASH\s+SALES\b/i,
  adjustments: /^(?:EXPENDITURES?|DISCOUNTS?|EXPENSES?|ADJUSTMENTS?|WRITE\s*-?\s*OFFS?)\b/i,
  tank: /^(?:TANK\s*DIP|TANKS?)\b|^STOCK\s+MOVEMENT\s+BY\s+TANK\b/i,
  tankProduct: /^STOCK\s+MOVEMENT\s+BY\s+PRODUCT\b/i,
  fuelReceived: /^FUEL\s+RECEIVED\b/i,
  attendant: /^(?:ATTENDANT\s+COLLECTION|ATTENDANTS?)\b/i,
  cashPosition: /^CASH\s+POSITION\b/i,
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
 * had to have finished. That is also why `EXPENDITURES` and `DISCOUNTS` are one entry and not
 * two — the real report titles its expense block `Expenditures` and prints the expense itself
 * as `Discounts & Bonuses …`, and two entries would have let the block's own first data row
 * close the block that contains it.
 *
 * The last three are unanchored legacy headings kept for reports already on file. They are
 * safe unanchored because none of the words is a column heading on any report seen so far.
 */
const SECTION_BOUNDARIES: RegExp[] = [
  ...Object.values(SECTION_HEADERS),
  /\bMOBILE\s+MONEY\b/i,
  /\bRECONCILIATION\b/i,
  /\b(TOTALIZER|BANK\s+DEPOSITS?|CASH\s+COLLECTED)\b/i,
];

/**
 * A printed block total: `Total 4,040,308.14`, or `Total 200 27 TZS 905,359.00`.
 *
 * Read as a row it invents a record. On the real report the attendant block closes with
 * `Total 0 4,040,308.14 4,040,200.00 -108.14`, which became an attendant named `TOTAL` owed
 * four million shillings, and the expenditures block's total became a second copy of the
 * expense printed above it, doubling the station's recorded expenses.
 *
 * Every row parser skips these, because on every layout seen the total is a sum of the rows
 * immediately above it and never a row of its own.
 */
function isSectionTotalRow(flat: string): boolean {
  return /^(?:SUB\s*-?\s*|GRAND\s+)?TOTAL\b/i.test(flat);
}

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

/**
 * `OILCOM T LTD MC863FJY 12 PUMP 1 - PUMP 2 - S1 3,917.00 47,004.00`
 *
 * The column layout in front of the figures — customer, then the vehicle — read by its own
 * shape rather than by a plate pattern.
 *
 * `PLATE_PATTERN` reads the older layout, where the plate is the only thing on the row that
 * looks like one. It cannot read this one: `SU45107` has five digits and no trailing letters,
 * and `T303EQU` has letters after the digits, so the pattern matches neither, and the two
 * rows that *do* match it are matched by accident. What does hold on both rows is the column
 * order: the vehicle is the last word before the first figure that is wholly a number, which
 * is the quantity column. Everything before it is the customer's name.
 */
function readVehicleColumns(flat: string): { vehicle: string; customer: string } | null {
  const tokens = flat.split(/\s+/);
  const firstFigure = tokens.findIndex((token) => /^\d[\d,]*(?:\.\d+)?$/.test(token));
  if (firstFigure < 1) {
    return null;
  }

  const vehicle = tokens[firstFigure - 1].replace(/[^\w-]/g, '');
  if (!vehicle || !/[A-Za-z]/.test(vehicle)) {
    return null;
  }

  return { vehicle, customer: tokens.slice(0, firstFigure - 1).join(' ') };
}

function parseCreditSales(lines: Line[], range: { start: number; end: number }): ParsedField[] {
  const fields: ParsedField[] = [];
  let unidentified = 0;

  /*
   * Which of the two layouts this block is in is decided by the block's own column heading,
   * not by the shape of a row. The heading is the report telling us what its columns are, and
   * it is the only place that says so; guessing from a row means a row that does not fit gets
   * read as if it did.
   */
  const nozzleLayout = lines
    .slice(range.start, range.end)
    .some((line) => /\bTRUCK\s+NUMBER\b/i.test(line.flat));

  for (let i = range.start; i < range.end; i += 1) {
    const line = lines[i];
    if (line.consumed || !hasDigit(line.flat) || line.flat.length < 3 || isManualAdjustmentRow(line.flat)) {
      continue;
    }
    if (isSectionTotalRow(line.flat)) {
      continue;
    }

    if (nozzleLayout) {
      /*
       * The money is the *last* figure on the row. The columns before it are the quantity and
       * the unit price, and the pump names carry digits of their own (`PUMP 1 - PUMP 2 - S1`),
       * so taking the first figure after the vehicle — which is what the older layout wants —
       * read the quantity 12 as the amount of a 47,004 shilling sale.
       */
      const columns = readVehicleColumns(line.flat);
      const amount = findAmounts(line.flat).at(-1);
      if (columns && amount) {
        line.consumed = true;
        const plate = slugify(columns.vehicle);
        fields.push(
          makeField({
            fieldName: `credit_sale:${plate}`,
            label: `Credit sale - ${columns.vehicle.toUpperCase()}`,
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

/**
 * The `Cash Sales` block: one row per product, with the litres sold, the unit price and the
 * money taken over the counter for that product.
 *
 * The older layout has no such block; its totalizer figure covers the same money in one line.
 * Both are read where they appear, and `deriveTotalizer` below uses the itemised rows when the
 * totalizer line is absent.
 */
function parseCashSalesRows(lines: Line[], range: { start: number; end: number }): ParsedField[] {
  const fields: ParsedField[] = [];

  for (let i = range.start; i < range.end; i += 1) {
    const line = lines[i];
    if (line.consumed || !hasDigit(line.flat) || isSectionTotalRow(line.flat)) {
      continue;
    }

    const amounts = findAmounts(line.flat);
    // Litres and money at minimum. A row with one figure is a label with a number in it, not a
    // product line, and there is no column it could be trusted to be.
    if (amounts.length < 2) {
      continue;
    }

    const nameMatch = /^([A-Za-z][A-Za-z0-9 &./'-]*?)\s+\d/.exec(line.flat);
    if (!nameMatch) {
      continue;
    }

    line.consumed = true;
    const product = nameMatch[1].trim();
    const amount = amounts[amounts.length - 1];

    fields.push(
      makeField({
        fieldName: `cash_sales:${slugify(product)}`,
        label: `Cash sales - ${product}`,
        group: 'CASH_PAYMENTS',
        rawValue: amount.raw,
        parsedValue: String(amount.amount),
        amount: amount.amount,
        confidence: 'HIGH',
        needsReview: false,
        regionText: line.text,
      })
    );
  }

  return fields;
}

function parseAttendantRows(lines: Line[], range: { start: number; end: number }): ParsedField[] {
  const fields: ParsedField[] = [];

  /**
   * How many rows this function has claimed, for naming one whose printed name could not be read.
   *
   * Counted rather than derived from `fields.length`, which is the earlier spelling: a row is not
   * always three fields — an unreadable one is two — so dividing by three produced a fractional
   * index and could hand two nameless rows the same key.
   */
  let rowCount = 0;

  /*
   * The real report's attendant block prints one column more than the older layout. Between the
   * name and `Amount To Collect` sits `Amount Spent`:
   *
   *   Attendant Name | Collection Shift | Amount Spent | Amount To Collect | Amount Collected | Loss/Gain
   *
   * No column is ever blank, so every figure is present and a row reads as four or five
   * consecutive figures with nothing between them to say which is which. Read positionally as
   * the older layout reads — first figure owed, second figure collected — that takes the money
   * an attendant has already spent on the station's behalf as money they owe, and their float as
   * money they handed in. On this report it turns a 34 shilling shortfall into a 1,510,400
   * shilling surplus.
   *
   * The block's own column heading is what says which layout this is, and it is the only thing
   * that does. It is read from the heading row rather than inferred from a count of figures,
   * because a count cannot tell a five-column block from a four-column one whose row happens to
   * carry an extra number.
   */
  const spentColumn = lines
    .slice(range.start, range.end)
    .some((line) => /\bAMOUNT\s+TO\s+COLLECT\b/i.test(line.flat));

  /** The shift word the real layout prints as its second column, after the person's name. */
  const SHIFT_SUFFIX = /\s+(?:DAY|NIGHT)$/i;

  for (let i = range.start; i < range.end; i += 1) {
    const line = lines[i];
    if (line.consumed || !hasDigit(line.flat) || isManualAdjustmentRow(line.flat)) {
      continue;
    }
    if (isSectionTotalRow(line.flat)) {
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
    const matchedName = nameMatch ? nameMatch[1].replace(/[\s.]+$/, '').trim() : null;
    // `AMINA MOHAMMED SHARIF DAY` is one person on the day shift, not a person whose surname
    // is Day. Left on, the shift word would make the same attendant a different key on nights
    // and would name them wrongly on every screen they appear on.
    const name = matchedName ? matchedName.replace(SHIFT_SUFFIX, '') : null;
    const allFigures = findAmounts(nameMatch ? rowText.slice(nameMatch[0].length) : rowText);
    // Drop the spent column, if this block has one, so what is left is the same pair of
    // reconcile figures the older layout prints.
    const figures = spentColumn ? allFigures.slice(1) : allFigures;

    line.consumed = true;
    rowCount += 1;
    const slug = name ? slugify(name) : `attendant_${rowCount}`;
    const label = name ?? 'Attendant';

    if (figures.length < 2) {
      /*
       * A row whose two figures could not be told apart, written as the two fields it should have
       * — both empty, both flagged — rather than as one row-level flag.
       *
       * The difference is whether a person can settle it. A manager has the paper in front of
       * them and can read both figures off it, and the correction path can only write to a field
       * that exists. A single `attendant:<slug>:row` field leaves the flag with no control that
       * can clear it: correcting one number would not produce the pair the row is for, so the
       * report sits in NEEDS_REVIEW for good — and re-parsing cannot help, because the same
       * ambiguous line is unreadable every time.
       *
       * Nothing is guessed at in the meantime. Both figures are null, so the variance stays
       * unknown and the row is left out of the card's totals and out of the person's profile
       * exactly as before (`shiftsNotComparable`, never a zero); the name is still read from the
       * line, so the row is attributed to the right person. The one amount that *was* found is
       * deliberately not attached to either column: which of the two it is, is the very thing
       * that could not be read, and filing it under one would invent a figure in a specific
       * column. It stays visible in `regionText`, where the reviewer reads the line for
       * themselves.
       */
      const note =
        figures.length === 1
          ? 'One figure was read on this row, but not which column it belongs to. Type both figures in from the paper report.'
          : 'No figure could be read on this row. Type both figures in from the paper report.';

      fields.push(
        makeField({
          fieldName: `attendant:${slug}:expected`,
          label: `${label} - to collect`,
          group: 'ATTENDANT_RECONCILIATION',
          rawValue: null,
          parsedValue: null,
          amount: null,
          confidence: 'LOW',
          needsReview: true,
          reviewNote: note,
          regionText: line.text,
        }),
        makeField({
          fieldName: `attendant:${slug}:collected`,
          label: `${label} - collected`,
          group: 'ATTENDANT_RECONCILIATION',
          rawValue: null,
          parsedValue: null,
          amount: null,
          confidence: 'LOW',
          needsReview: true,
          reviewNote: note,
          regionText: line.text,
        })
      );
      continue;
    }

    const expected = figures[0].amount;
    const collected = figures[1].amount;

    /*
     * The report's `Loss/Gain` column is `collected − expected`, the negation of this product's
     * variance (`computeSummary`: a positive variance is money the station cannot account for).
     * Copying the printed figure would show a shortfall as a surplus in the one column a manager
     * reads first, so the variance is derived from the two figures that were read — the same
     * choice `tankVariance` makes for litres and for the same reason.
     *
     * On the older layout there is no loss/gain column to disagree with, and a third figure if
     * one is printed is already this product's figure.
     */
    const variance = spentColumn ? expected - collected : figures[2]?.amount ?? expected - collected;
    const printedVariance = spentColumn ? figures[2]?.amount : undefined;

    /*
     * Where the block prints its own loss/gain, it is a check on the two figures that were read:
     * `collected − expected` must equal it, in magnitude and sign. If it does not, a column has
     * been misread — most likely a blank cell on one row shifting everything after it left by
     * one — and the row is flagged rather than stored, because every figure in it is then in
     * doubt and a manager has the paper in front of them.
     */
    const columnsDisagree =
      printedVariance !== undefined && Math.abs(collected - expected - printedVariance) > 0.01;
    const disagreementNote =
      'The loss/gain printed for this attendant does not match the figures read on the row. Check all the figures on this line against the paper report.';

    fields.push(
      makeField({
        fieldName: `attendant:${slug}:expected`,
        label: `${label} - to collect`,
        group: 'ATTENDANT_RECONCILIATION',
        rawValue: figures[0].raw,
        parsedValue: String(expected),
        amount: expected,
        confidence: 'HIGH',
        needsReview: columnsDisagree,
        reviewNote: columnsDisagree ? disagreementNote : null,
        regionText: line.text,
      }),
      makeField({
        fieldName: `attendant:${slug}:collected`,
        label: `${label} - collected`,
        group: 'ATTENDANT_RECONCILIATION',
        rawValue: figures[1].raw,
        parsedValue: String(collected),
        amount: collected,
        confidence: 'HIGH',
        needsReview: columnsDisagree,
        reviewNote: columnsDisagree ? disagreementNote : null,
        regionText: line.text,
      }),
      makeField({
        fieldName: `attendant:${slug}:variance`,
        label: `${label} - variance`,
        group: 'ATTENDANT_RECONCILIATION',
        // The printed loss/gain is deliberately not carried as `rawValue`: it is the negation
        // of the figure stored beside it, and a reviewer comparing the two on screen would read
        // a sign the product does not mean.
        rawValue: spentColumn ? null : figures[2]?.raw ?? null,
        parsedValue: String(variance),
        amount: variance,
        confidence: spentColumn ? 'HIGH' : figures[2] ? 'HIGH' : 'LOW',
        // A variance the report did not print but which follows from the two figures that
        // were read is arithmetic, not a judgement call. Flagging it would put a row in
        // the manager's review queue every single shift and drown the rows that genuinely
        // need a human.
        needsReview: columnsDisagree,
        reviewNote: columnsDisagree
          ? disagreementNote
          : spentColumn || figures[2]
            ? null
            : 'Calculated from the figures shown for this attendant',
        regionText: line.text,
      })
    );
  }

  return fields;
}

/**
 * The tank's name on a Stock Movement row: `AGO 3`, `PMS`, `AGO - DIESEL`.
 *
 * The name can end in a number and so can the first column of the table beside it, so the split
 * cannot be made by looking for the first figure — `AGO 3 954.054 0 …` would come back as the
 * tank `AGO`. What identifies the boundary is the table itself: seven columns, so eight figures
 * on a row means the first of them is part of the name.
 */
function leadingTankLabel(flat: string, figureCount: number): string {
  const label = /^([A-Za-z][A-Za-z0-9 ._/-]*?)\s+(?=-?\d)/.exec(flat)?.[1] ?? '';
  if (figureCount >= 8) {
    const first = findAmounts(flat)[0];
    return `${label} ${first.raw}`.trim();
  }
  return label.trim();
}

function parseTankRows(lines: Line[], range: { start: number; end: number }): ParsedField[] {
  const fields: ParsedField[] = [];

  for (let i = range.start; i < range.end; i += 1) {
    const line = lines[i];
    if (line.consumed || !hasDigit(line.flat) || isManualAdjustmentRow(line.flat)) {
      continue;
    }
    if (isSectionTotalRow(line.flat)) {
      continue;
    }

    const allFigures = findAmounts(line.flat);

    /*
     * The real report's `Stock Movement By Tank` table prints seven figures per row, in this
     * order:
     *
     *   Opening Balance | RTT | Addition | Liters Sold | Book Stock | Closing Dipping | Variance
     *
     * The two figures this product stores are the fifth and sixth, so they are read from there.
     * Read positionally as the older two-figure layout reads them — first figure book stock,
     * second closing dip — the opening balance was stored as the book stock and the RTT as the
     * closing dip, which reports a variance of zero for every tank on every shift *and* a book
     * stock of zero for any tank the report prints as empty. The whole tank-leakage feature then
     * has nothing true to say, from a report whose own variance column is non-zero.
     *
     * `litresSold` (the fourth) is deliberately not stored. It is the same fuel the pump sales
     * block accounts for in money, and deriving one from the other here would be inventing a
     * figure the report does not print.
     */
    const columns =
      allFigures.length >= 7
        ? allFigures.length === 7
          ? allFigures
          : allFigures.slice(allFigures.length - 7)
        : null;

    // Read the tank identifier from the identifier rule, not from the start of the line:
    // on `TANK 1 PMS 12,000 11,500` the first token is the literal word "TANK", which
    // would label every tank identically.
    const remainder = columns ? '' : stripLeadingIndex(line.flat);
    const legacyFigures = columns ? [] : findAmounts(remainder);

    if (allFigures.length === 0 || (!columns && legacyFigures.length === 0)) {
      continue;
    }

    line.consumed = true;
    const tankId = columns
      ? leadingTankLabel(line.flat, allFigures.length)
      : TANK_ID_PATTERN.exec(line.flat)?.[1] ?? String(fields.length / 2 + 1);
    const tankSlug = slugify(tankId);
    const bookStock = columns ? columns[4] : legacyFigures[0];
    const closingDip = columns ? columns[5] : legacyFigures[1];

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
    if (line.consumed || !hasDigit(line.flat) || isSectionTotalRow(line.flat)) {
      continue;
    }

    const keyword = ALWAYS_REVIEW_KEYWORDS.exec(line.flat);
    /*
     * The money is the last figure on the row, and on a real report it has to be. The row is
     *
     *   Discounts & Bonuses   CASHBACK DISCOUNT LTRS310   15,100.00
     *
     * where the trailing `310` is glued to the word in front of it — a litres count, not money,
     * and there is nothing in the text to say so. Reading the first figure stored 310 shillings
     * of discount beside a row whose own total says 15,100.
     */
    const amount = findAmounts(line.flat).at(-1);
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
    if (
      line.consumed ||
      !ALWAYS_REVIEW_KEYWORDS.test(line.flat) ||
      !hasDigit(line.flat) ||
      isSectionTotalRow(line.flat)
    ) {
      continue;
    }
    // Last figure, for the reason given in `parseAdjustments`.
    const amount = findAmounts(line.flat).at(-1);
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

  const cashSalesFields = fields.filter(
    (f) => f.fieldName.startsWith('cash_sales:') && f.amount !== null
  );
  const creditFields = fields.filter((f) => f.fieldName.startsWith('credit_sale:') && f.amount !== null);

  /**
   * The shift's total sales, added up from the blocks that itemise them.
   *
   * The real report prints no totalizer line of any kind. What it prints instead is the same
   * quantity split in two: a `Cash Sales` block carrying the money taken over the counter, and a
   * `Nozzle Credit Sales` block carrying the money sold on account. Together they are the figure
   * the older layout labels `TOTALIZER SALES`.
   *
   * Derived here, at reading time, rather than by the parser writing a totalizer field of its own
   * — the same reason the variance and the tank figures are derived. A total added up once at
   * upload and stored would go on reporting what the parser first saw: a manager who corrects a
   * product's cash figure would watch the row above it change and the variance below it not move.
   *
   * Null when the report has no cash sales block, which is every report in the older layout:
   * there the totalizer line is printed, read, and correctable in its own right, and this must not
   * replace it with a sum of whatever happened to be itemised alongside it.
   */
  const derivedTotalSales =
    cashSalesFields.length > 0
      ? [...cashSalesFields, ...creditFields].reduce((sum, field) => sum + (field.amount ?? 0), 0)
      : null;

  const gradeTotalizers = fields.filter((f) => f.fieldName.startsWith('pump_totalizer_sales:'));
  const pumpTotalizerSales =
    derivedTotalSales ??
    scalarAmount('pump_totalizer_sales') ??
    (gradeTotalizers.length > 0
      ? gradeTotalizers.reduce((sum, f) => sum + (f.amount ?? 0), 0)
      : null);

  const cash = scalarAmount('cash_collected');

  const mobileFields = fields.filter((f) => f.fieldName.startsWith('mobile_money'));
  const mobileMoney = mobileFields.reduce((sum, f) => sum + (f.amount ?? 0), 0);

  const approvedCredit = creditFields.reduce((sum, f) => sum + (f.amount ?? 0), 0);

  const contributors = [
    ...mobileFields,
    ...cashSalesFields,
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

/**
 * Whether the report itemises its sales instead of printing a total for them.
 *
 * The real layout prints no totalizer line. Its label scan therefore lands on the `Total Sales`
 * column heading of the pump table and leaves a `pump_totalizer_sales` field with no figure in
 * it, which is worse than leaving it out: the review screen would put a flagged, empty row in
 * front of a manager and ask for a number the report never printed, while the figure they can
 * actually check sits in the cash and credit blocks beside it. See `computeSummary`, which
 * derives the total from those blocks on every read.
 */
function itemisesSales(fields: ParsedField[]): boolean {
  return fields.some((field) => field.fieldName.startsWith('cash_sales:') && field.amount !== null);
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

  const cashSalesRange = findSectionRange(lines, SECTION_HEADERS.cashSales, boundariesExcept(SECTION_HEADERS.cashSales));
  if (cashSalesRange) {
    fields.push(...parseCashSalesRows(lines, cashSalesRange));
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

  /*
   * A report that itemises its sales prints no total for them, so the label scan above has left
   * a flagged, empty `pump_totalizer_sales` behind — it matched the `Total Sales` column heading
   * on the pump table. Drop it rather than fill it in: the figure is derived from the itemised
   * blocks on every read (`computeSummary`), and a field holding no value would put a row in
   * front of a manager asking them to type in a number the report never printed.
   */
  const collected = itemisesSales(fields)
    ? fields.filter((field) => field.fieldName !== 'pump_totalizer_sales')
    : fields;

  const uniqueFields = dedupeFieldNames(collected);
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
