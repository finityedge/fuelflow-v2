/**
 * The four review cards, built from the flat field list.
 *
 * The API hands back one row per figure, which is the right shape for a database and the
 * wrong one for a screen: a manager reads "Tank 1 held 12,000 and 11,500 were dipped", not
 * two unrelated rows called `tank:1:book_stock` and `tank:1:closing_dip`. Everything below
 * turns the flat list into those grouped rows, and it is kept pure and free of React so the
 * grouping can be reasoned about — and argued with — without rendering anything.
 *
 * Two rules run through all of it:
 *
 *  - A figure that was never read is `null`, never `0`. Zero is a number a station can be
 *    accountable for; "nobody could read this" is not, and every total here is `null` the
 *    moment one of its parts is missing rather than quietly coming out short.
 *  - Nothing derived here is written back. Each row keeps the `ExtractedField` it came from,
 *    so the row can be corrected through the same endpoint and the same id.
 */

import type { ExtractedField } from '@fuelflow/shared';

/** `amount` is optional on the wire, so this is the only place that decides what "empty" is. */
function amountOf(field: ExtractedField | null | undefined): number | null {
  return field?.amount ?? null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** `JUMA_M` -> `JUMA M`, for a row the parser could not give a written name to. */
function nameFromSlug(slug: string): string {
  return slug
    .replace(/_\d+$/, '')
    .replace(/_/g, ' ')
    .trim()
    .toUpperCase();
}

function initialsFor(name: string): string {
  const words = name.split(/[\s.]+/).filter(Boolean);
  if (words.length === 0) {
    return '?';
  }
  return words
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('');
}

/**
 * The name the parser wrote into the label, put back.
 *
 * The rows for one attendant are labelled `Juma M. - to collect`, `Juma M. - collected`,
 * `Juma M. - variance`, or `Juma M. - unreadable row` when the two figures could not both be
 * read. Splitting on the first ` - ` would break on a name that contains one, so the known
 * suffixes are what come off.
 */
function attendantName(label: string): string {
  return label.replace(/ - (to collect|collected|variance|unreadable row)$/i, '').trim();
}

/**
 * Ordering, everywhere below.
 *
 * These rows are NOT in the order they appear on the printed report, and they cannot be:
 * the fields are written with one `createMany`, so every row carries the same timestamp and
 * the database holds no record of where on the page a figure sat. What is left is the order
 * the API happens to return, which is alphabetical by machine key — `GRACE KIMARO` above
 * `JOHN MWAKA` whatever the paper said.
 *
 * So each list is sorted by the key someone would actually search by instead of inheriting
 * that: attendants and plates by name, tanks numerically so `Tank 10` follows `Tank 2`.
 * A recorded printed order would be better and needs a column to hold it; until then,
 * predictable beats arbitrary.
 *
 * The one place the report's own ordering is known and honoured is mobile money, whose
 * providers the parser declares in a fixed order (see `MOBILE_PROVIDER_ORDER`).
 */
const BY_NAME = (a: string, b: string) => a.localeCompare(b);

/** M-Pesa, Tigo Pesa, Airtel Money — the order the parser looks for them in. */
const MOBILE_PROVIDER_ORDER = ['m_pesa', 'tigo_pesa', 'airtel_money'];

function mobileProviderRank(fieldName: string): number {
  const suffix = fieldName.replace(/^mobile_money:/, '').toLowerCase();
  const rank = MOBILE_PROVIDER_ORDER.indexOf(suffix);
  return rank === -1 ? MOBILE_PROVIDER_ORDER.length : rank;
}

/** The counter the parser appends to a manual entry, or a large number if it has none. */
function adjustmentIndex(fieldName: string): number {
  const trailing = /_(\d+)$/.exec(fieldName);
  return trailing ? Number(trailing[1]) : Number.MAX_SAFE_INTEGER;
}

export interface CashView {
  cash: ExtractedField | null;
  /** One row per provider, or the single combined total, or the row flagging that none was read. */
  mobile: ExtractedField[];
  deposits: ExtractedField[];
  /** Discounts, expenses and write-offs. Always flagged — they are the entries nothing can verify. */
  adjustments: ExtractedField[];
  /**
   * Cash plus mobile money: exactly the figures the headline variance subtracts, and nothing
   * else. A total that quietly included the bank deposits would disagree with the number at
   * the top of the page, and there would be no way to tell which one was wrong.
   */
  countedTotal: number | null;
  /** True when a figure the total depends on was never read, so the total is unknown, not low. */
  countedIncomplete: boolean;
}

export function cashView(fields: ExtractedField[]): CashView {
  const cash = fields.find((field) => field.fieldName === 'cash_collected') ?? null;
  const mobile = fields
    .filter((field) => field.fieldName.startsWith('mobile_money'))
    .sort(
      (a, b) =>
        mobileProviderRank(a.fieldName) - mobileProviderRank(b.fieldName) ||
        BY_NAME(a.fieldName, b.fieldName)
    );
  const deposits = fields.filter((field) => field.fieldName === 'bank_deposit_total');
  /**
   * Manual entries, in the order the parser met them.
   *
   * These are the only rows whose position is recoverable at all: the parser numbers them as
   * it goes (`adjustment:CASHBACK_1`), and that number is the order they were printed in. The
   * name is the tiebreak for the two passes that both start counting at one.
   */
  const adjustments = fields
    .filter((field) => field.fieldName.startsWith('adjustment:'))
    .sort(
      (a, b) =>
        adjustmentIndex(a.fieldName) - adjustmentIndex(b.fieldName) || BY_NAME(a.label, b.label)
    );

  const counted = [cash, ...mobile].filter((field): field is ExtractedField => field !== null);
  const countedIncomplete = counted.some((field) => amountOf(field) === null);

  return {
    cash,
    mobile,
    deposits,
    adjustments,
    countedTotal: countedIncomplete ? null : sum(counted.map((field) => amountOf(field) ?? 0)),
    countedIncomplete,
  };
}

export interface CreditRow {
  key: string;
  /** The vehicle's plate as printed, or a plain statement that it could not be read. */
  plate: string;
  identified: boolean;
  field: ExtractedField;
}

export interface CreditView {
  rows: CreditRow[];
  total: number;
  unidentified: number;
  incomplete: boolean;
}

export function creditView(fields: ExtractedField[]): CreditView {
  const rows = fields
    .filter((field) => field.fieldName.startsWith('credit_sale:'))
    .map((field) => {
      const identified = !field.fieldName.startsWith('credit_sale:unidentified');
      return {
        key: field.id,
        // The plate was printed as `T 342 DFC` and the label the parser wrote kept it, so it
        // is read back out rather than reconstructed from the slug, which lost the spaces.
        plate: identified ? field.label.replace(/^Credit sale - /, '') : 'Plate not read',
        identified,
        field,
      };
    });

  return {
    rows: rows.sort((a, b) => BY_NAME(a.plate, b.plate)),
    total: sum(rows.map((row) => amountOf(row.field) ?? 0)),
    // A credit sale with an unreadable plate is still a real debt someone owes; it is counted
    // in the total and flagged in its row, not dropped.
    unidentified: rows.filter((row) => !row.identified).length,
    incomplete: rows.some((row) => amountOf(row.field) === null),
  };
}

export interface AttendantRow {
  key: string;
  name: string;
  initials: string;
  toCollect: ExtractedField | null;
  collected: ExtractedField | null;
  variance: ExtractedField | null;
  /** Set when the row itself could not be split into two figures. */
  unreadable: ExtractedField | null;
  varianceAmount: number | null;
}

export interface AttendantView {
  rows: AttendantRow[];
  totalToCollect: number | null;
  totalCollected: number | null;
  /** Attendants who handed over less than they should have. */
  shortCount: number;
  /** And those who handed over more. The two cancel in the totals below, as they do anywhere. */
  overCount: number;
}

export function attendantView(fields: ExtractedField[]): AttendantView {
  const bySlug = new Map<string, AttendantRow>();

  for (const field of fields) {
    if (!field.fieldName.startsWith('attendant:')) {
      continue;
    }
    const [, slug = '', kind = ''] = field.fieldName.split(':');
    const existing = bySlug.get(slug);
    const row: AttendantRow =
      existing ??
      {
        key: slug,
        name: attendantName(field.label) || nameFromSlug(slug),
        initials: '',
        toCollect: null,
        collected: null,
        variance: null,
        unreadable: null,
        varianceAmount: null,
      };

    if (kind === 'expected') {
      row.toCollect = field;
    } else if (kind === 'collected') {
      row.collected = field;
    } else if (kind === 'variance') {
      row.variance = field;
    } else {
      row.unreadable = field;
      row.name = attendantName(field.label) || nameFromSlug(slug);
    }

    bySlug.set(slug, row);
  }

  const rows = [...bySlug.values()].map((row) => {
    row.initials = initialsFor(row.name);

    // The report usually prints the difference itself; where it did not, the parser works it
    // out from the two figures it read. Both arrive as the variance field's amount. The
    // subtraction here only covers a variance field that somehow carries no amount.
    const printed = amountOf(row.variance);
    const toCollect = amountOf(row.toCollect);
    const collected = amountOf(row.collected);
    row.varianceAmount =
      printed ?? (toCollect !== null && collected !== null ? toCollect - collected : null);

    return row;
  });

  const expected = rows.map((row) => amountOf(row.toCollect));
  const got = rows.map((row) => amountOf(row.collected));

  return {
    rows: rows.sort((a, b) => BY_NAME(a.name, b.name)),
    // `expected - collected` is positive when an attendant handed over less than they should
    // have, which is the same direction as the headline variance. One convention, both places.
    shortCount: rows.filter((row) => (row.varianceAmount ?? 0) > 0).length,
    overCount: rows.filter((row) => (row.varianceAmount ?? 0) < 0).length,
    totalToCollect: expected.some((value) => value === null) ? null : sum(expected as number[]),
    totalCollected: got.some((value) => value === null) ? null : sum(got as number[]),
  };
}

export interface TankRow {
  key: string;
  tankId: string;
  bookStock: ExtractedField | null;
  closingDip: ExtractedField | null;
  /** Book stock less the dip: positive means less fuel in the tank than the book says. */
  difference: number | null;
  /** The difference as a share of book stock, which is the figure that says whether it matters. */
  differencePercent: number | null;
}

export interface TankView {
  rows: TankRow[];
  /**
   * Summed across tanks, and therefore cancellable: a tank that gained hides one that lost.
   * The counts below travel with it so the screen can say so instead of showing a total that
   * looks smaller than the loss a manager can see in the rows.
   */
  totalDifference: number | null;
  losses: number;
  gains: number;
  /** True when tanks moved in both directions, so the total is not the size of the problem. */
  bothDirections: boolean;
}

export function tankView(fields: ExtractedField[]): TankView {
  const bySlug = new Map<string, TankRow>();

  for (const field of fields) {
    if (!field.fieldName.startsWith('tank:')) {
      continue;
    }
    const [, slug = '', kind = ''] = field.fieldName.split(':');
    const row: TankRow =
      bySlug.get(slug) ??
      {
        key: slug,
        tankId: field.label.replace(/^Tank /, '').replace(/ - .*$/, '') || slug,
        bookStock: null,
        closingDip: null,
        difference: null,
        differencePercent: null,
      };

    if (kind === 'book_stock') {
      row.bookStock = field;
    } else {
      row.closingDip = field;
    }

    bySlug.set(slug, row);
  }

  const rows = [...bySlug.values()].map((row) => {
    const book = amountOf(row.bookStock);
    const dip = amountOf(row.closingDip);

    if (book === null || dip === null) {
      return row;
    }

    row.difference = book - dip;
    row.differencePercent = book > 0 ? (row.difference / book) * 100 : null;
    return row;
  });

  const differences = rows
    .map((row) => row.difference)
    .filter((value): value is number => value !== null);
  const losses = differences.filter((value) => value > 0).length;
  const gains = differences.filter((value) => value < 0).length;

  return {
    rows: rows.sort((a, b) => a.tankId.localeCompare(b.tankId, undefined, { numeric: true })),
    // Withheld entirely if any tank is missing a reading: a total summed over the tanks that
    // happened to parse reads as the whole shift's loss and is nothing of the sort.
    totalDifference:
      rows.length > 0 && rows.every((row) => row.difference !== null) ? sum(differences) : null,
    losses,
    gains,
    bothDirections: losses > 0 && gains > 0,
  };
}

/** The one figure the variance is built from that is not a payment, kept out of the cash card. */
export function totalizerField(fields: ExtractedField[]): ExtractedField | null {
  return fields.find((field) => field.fieldName === 'pump_totalizer_sales') ?? null;
}
