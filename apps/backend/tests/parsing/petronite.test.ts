/**
 * Parser tests.
 *
 * NOTE ON THE FIXTURES: no real Petronite report was available when these were written.
 * They are synthesised to the structure the product spec describes — totalizer sales,
 * cash, itemised mobile money, credit sales by plate, attendant reconciliation, tank dips,
 * and a manual discount — with the spacing varied between them so the template tolerance
 * is actually exercised. Every figure below is invented. When a real report is available
 * it should be added here as-is, and any assertion it breaks is a genuine finding.
 */

import { describe, expect, it } from 'vitest';
import { parseShiftReportText } from '../../src/parsing/petronite.js';
import type { ParsedField } from '../../src/parsing/types.js';

function fieldOf(fields: ParsedField[], fieldName: string): ParsedField | undefined {
  return fields.find((field) => field.fieldName === fieldName);
}

/** Fixture A: the tidy layout — aligned columns, dot leaders, one block per area. */
const REPORT_A = `PETRONITE FUEL STATION
SHIFT REPORT
Station: Main Station
Date: 12/03/2026
Shift: Day

TOTALIZER SALES ................ 18,450,000
CASH COLLECTED ................. 9,120,000
BANK DEPOSITS .................. 5,000,000

MOBILE MONEY
M-Pesa ......................... 4,200,000
Tigo Pesa ...................... 1,130,000

CREDIT SALES
T 123 ABC ...................... 850,000
T 456 DEF ...................... 150,000

ATTENDANTS
JOHN MWAKA ....... 3,200,000 3,150,000
GRACE KIMARO ..... 5,920,000 5,970,000

TANK DIP
TANK 1 PMS 12,000 11,500
TANK 2 AGO 8,000 7,800

RECONCILIATION
Cashback discount .............. 50,000
`;

/** Fixture B: the messy layout — ragged spacing, values on the line below, a bare total. */
const REPORT_B = `PETRONITE
SHIFT   REPORT
Station      Main Station
Shift Date: 2026-03-13

TOTALIZER
   TOTALIZER SALES
   17,100,000

CASH
   CASH COLLECTED      8,000,000

MOBILE MONEY TOTAL   2,500,000

CREDIT SALES
AB 456 CD      300,000

ATTENDANTS
   PETER JOHN    4,000,000   3,950,000

TANKS
   TANK A   5,000   4,900
`;

/** Fixture C: a partial report — no totalizer figure, no cash line, a tank with one reading. */
const REPORT_C = `PETRONITE FUEL STATION
SHIFT REPORT
Station: Main Station
Date: 2026-03-14

BANK DEPOSITS .................. 5,000,000

MOBILE MONEY
M-Pesa ......................... 4,200,000

CREDIT SALES
T 123 ABC ...................... 850,000

ATTENDANTS
JOHN MWAKA ....... 3,200,000 3,150,000

TANK DIP
TANK 1 PMS 12,000

RECONCILIATION
`;

/** Fixture D: an unrelated document. */
const REPORT_D = `INVOICE 4471
Supplier: Some Other Vendor Ltd
Amount due: 1,200,000
Payment terms: 30 days
`;

describe('parseShiftReportText - tidy report', () => {
  const result = parseShiftReportText(REPORT_A);

  it('extracts the headline figures', () => {
    expect(fieldOf(result.fields, 'pump_totalizer_sales')?.amount).toBe(18_450_000);
    expect(fieldOf(result.fields, 'cash_collected')?.amount).toBe(9_120_000);
    expect(fieldOf(result.fields, 'bank_deposit_total')?.amount).toBe(5_000_000);
  });

  it('itemises mobile money by provider', () => {
    expect(fieldOf(result.fields, 'mobile_money:M_PESA')?.amount).toBe(4_200_000);
    expect(fieldOf(result.fields, 'mobile_money:TIGO_PESA')?.amount).toBe(1_130_000);
  });

  it('itemises credit sales by vehicle plate', () => {
    expect(fieldOf(result.fields, 'credit_sale:T_123_ABC')?.amount).toBe(850_000);
    expect(fieldOf(result.fields, 'credit_sale:T_456_DEF')?.amount).toBe(150_000);
  });

  it('reconciles each attendant across three figures', () => {
    expect(fieldOf(result.fields, 'attendant:JOHN_MWAKA:expected')?.amount).toBe(3_200_000);
    expect(fieldOf(result.fields, 'attendant:JOHN_MWAKA:collected')?.amount).toBe(3_150_000);
    expect(fieldOf(result.fields, 'attendant:JOHN_MWAKA:variance')?.amount).toBe(50_000);
    expect(fieldOf(result.fields, 'attendant:GRACE_KIMARO:variance')?.amount).toBe(-50_000);
  });

  it('reads book stock and closing dip per tank', () => {
    expect(fieldOf(result.fields, 'tank:1:book_stock')?.amount).toBe(12_000);
    expect(fieldOf(result.fields, 'tank:1:closing_dip')?.amount).toBe(11_500);
    expect(fieldOf(result.fields, 'tank:2:book_stock')?.amount).toBe(8_000);
    expect(fieldOf(result.fields, 'tank:2:closing_dip')?.amount).toBe(7_800);
  });

  it('reads the shift date off the report', () => {
    expect(result.reportDate).toBe('2026-03-12');
  });

  it('computes the variance as pump sales minus everything accounted for', () => {
    // 18,450,000 - (9,120,000 cash + 5,330,000 mobile + 1,000,000 credit) = 3,000,000
    expect(result.summary.mobileMoney).toBe(5_330_000);
    expect(result.summary.approvedCredit).toBe(1_000_000);
    expect(result.summary.variance).toBe(3_000_000);
    expect(result.summary.provisional).toBe(false);
  });

  it('always flags a manual discount, however cleanly it parsed', () => {
    const adjustment = fieldOf(result.fields, 'adjustment:CASHBACK_1');
    expect(adjustment).toBeDefined();
    expect(adjustment?.amount).toBe(50_000);
    expect(adjustment?.confidence).toBe('HIGH');
    expect(adjustment?.needsReview).toBe(true);
    expect(adjustment?.reviewNote).toMatch(/always require review/i);
  });

  it('names a manual entry by its description, not by the row it was printed on', () => {
    const adjustment = fieldOf(result.fields, 'adjustment:CASHBACK_1');
    // The row reads `Cashback discount ....... 50,000`. Using it whole as the label put the
    // dot leader and a second copy of the amount into the review list, where a manager is
    // scanning labels to find what is asking for them.
    expect(adjustment?.label).toBe('Cashback discount');
  });

  it('reports NEEDS_REVIEW with exactly the one field a human must see', () => {
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.fields.filter((field) => field.needsReview)).toHaveLength(1);
  });

  it('groups every field so the review screen can lay it out', () => {
    expect(new Set(result.fields.map((field) => field.group))).toEqual(
      new Set(['CASH_PAYMENTS', 'CREDIT_SALES', 'ATTENDANT_RECONCILIATION', 'TANK_READINGS'])
    );
  });
});

describe('parseShiftReportText - messy report', () => {
  const result = parseShiftReportText(REPORT_B);

  it('reads the same figures through ragged spacing', () => {
    expect(fieldOf(result.fields, 'cash_collected')?.amount).toBe(8_000_000);
    expect(fieldOf(result.fields, 'mobile_money_collected')?.amount).toBe(2_500_000);
    expect(fieldOf(result.fields, 'credit_sale:AB_456_CD')?.amount).toBe(300_000);
    expect(fieldOf(result.fields, 'attendant:PETER_JOHN:expected')?.amount).toBe(4_000_000);
    expect(fieldOf(result.fields, 'tank:A:closing_dip')?.amount).toBe(4_900);
  });

  it('reads the date in its other printed form', () => {
    expect(result.reportDate).toBe('2026-03-13');
  });

  it('falls back to a bare mobile money total when no provider is itemised', () => {
    expect(fieldOf(result.fields, 'mobile_money_collected')?.amount).toBe(2_500_000);
    expect(fieldOf(result.fields, 'mobile_money:M_PESA')).toBeUndefined();
  });

  it('flags a figure it had to guess at from the line below the label', () => {
    const totalizer = fieldOf(result.fields, 'pump_totalizer_sales');
    expect(totalizer?.amount).toBe(17_100_000);
    expect(totalizer?.confidence).toBe('LOW');
    expect(totalizer?.needsReview).toBe(true);
    expect(totalizer?.rawValue).toBe('17,100,000');
  });

  it('marks the variance provisional while a contributing figure is unverified', () => {
    expect(result.summary.provisional).toBe(true);
  });
});

/**
 * Two people whose names begin with an initial, on one report.
 *
 * This is a regression test for a merge that happened silently. The attendant parser stripped a
 * leading index with the same rule the tank parser uses, and that rule also removes a single
 * leading letter — so `J. MWANGI` and `P. MWANGI` both became `MWANGI` and the two people
 * shared one key. Nothing downstream could tell them apart afterwards: every shift either of
 * them worked landed on one record, and one of them would be shown the other's shortfalls.
 *
 * The failure is worth its own fixture because it is the exact harm the attendant-identity work
 * exists to prevent, arriving from the other direction. There, a similarity rule might guess
 * that two names are one person; here a string was made identical before any rule could run.
 */
const REPORT_INITIALS = `PETRONITE FUEL STATION
SHIFT REPORT
Date: 2026-03-15

ATTENDANTS
J. MWANGI ....... 3,200,000 3,150,000
P. MWANGI ....... 1,800,000 1,700,000
2. GRACE KIMARO .... 5,000,000 5,000,000

RECONCILIATION
`;

describe('parseShiftReportText - attendants with initials', () => {
  const result = parseShiftReportText(REPORT_INITIALS);

  it('keys each initialled name by the initial, so two people do not become one', () => {
    expect(fieldOf(result.fields, 'attendant:J_MWANGI:expected')?.amount).toBe(3_200_000);
    expect(fieldOf(result.fields, 'attendant:P_MWANGI:expected')?.amount).toBe(1_800_000);

    // The claim in one line: the two spellings produced two keys, not one.
    const keys = result.fields
      .map((field) => field.fieldName)
      .filter((name) => name.startsWith('attendant:MWANGI'));
    expect(keys).toEqual([]);
  });

  it('still strips a row number, which is what the stripper is for', () => {
    expect(fieldOf(result.fields, 'attendant:GRACE_KIMARO:expected')?.amount).toBe(5_000_000);
    expect(fieldOf(result.fields, 'attendant:GRACE_KIMARO:collected')?.amount).toBe(5_000_000);
  });

  it('names each attendant by what the report printed, without the dot leaders', () => {
    expect(fieldOf(result.fields, 'attendant:J_MWANGI:expected')?.label).toBe('J. MWANGI - to collect');
  });
});

/**
 * A row whose two figures could not be told apart, beside rows that read cleanly.
 *
 * The row is worth its own fixture because of what the parser does *not* do with it. It could
 * write one row-level flag and leave the row for a human, which is what it used to do — but a
 * flag with no control that can clear it is a report that never leaves NEEDS_REVIEW, and the
 * manager has the paper in front of them and can read both figures off it. So the row is written
 * as the two fields it should have, both empty, and the ordinary correction control fills them in.
 *
 * The nameless row at the end is here for a second reason: it is keyed by its position among the
 * rows, and an unreadable row is two fields where a readable one is three, so the old
 * `fields.length / 3` arithmetic gave this row a fractional key.
 */
const REPORT_UNREADABLE_ROW = `PETRONITE FUEL STATION
SHIFT REPORT
Date: 2026-03-16

ATTENDANTS
JOHN MWAKA ....... 3,200,000
GRACE KIMARO ..... 5,920,000 5,970,000
....... 1,800,000 1,700,000

RECONCILIATION
`;

describe('parseShiftReportText - an unreadable attendant row', () => {
  const result = parseShiftReportText(REPORT_UNREADABLE_ROW);

  it('writes the row as its two figures, empty and flagged, so a person can fill them in', () => {
    const expected = fieldOf(result.fields, 'attendant:JOHN_MWAKA:expected');
    const collected = fieldOf(result.fields, 'attendant:JOHN_MWAKA:collected');

    expect(expected).toBeDefined();
    expect(collected).toBeDefined();
    for (const field of [expected, collected]) {
      expect(field?.amount).toBeNull();
      expect(field?.parsedValue).toBeNull();
      expect(field?.needsReview).toBe(true);
      expect(field?.confidence).toBe('LOW');
    }

    // The label names the figure, which is what the correction form asks about.
    expect(expected?.label).toBe('JOHN MWAKA - to collect');

    // The shape it used to take, and the reason the flag could never be cleared: nothing on this
    // screen can write two figures at once, and correcting one number is not the pair.
    expect(fieldOf(result.fields, 'attendant:JOHN_MWAKA:row')).toBeUndefined();
    expect(result.fields.filter((field) => field.fieldName.endsWith(':row'))).toEqual([]);
  });

  it('says what to do about it, in the manager’s words', () => {
    const expected = fieldOf(result.fields, 'attendant:JOHN_MWAKA:expected');

    // A flag with no instruction sends somebody looking for a bug. One figure *was* found here,
    // and saying so is the difference between "this scan is unreadable" and "the second column
    // is".
    expect(expected?.reviewNote).toMatch(/type both figures in from the paper report/i);
    expect(expected?.reviewNote).toMatch(/which column/i);
  });

  it('keeps the figure it did find visible without filing it under either column', () => {
    const expected = fieldOf(result.fields, 'attendant:JOHN_MWAKA:expected');

    // Which column the 3,200,000 belongs to is the thing that could not be read, so attaching it
    // to one would invent a figure in a named column. It stays in the line the reviewer reads.
    expect(expected?.rawValue).toBeNull();
    expect(expected?.regionText).toContain('3,200,000');
  });

  it('leaves the rows that did read alone', () => {
    const graceExpected = fieldOf(result.fields, 'attendant:GRACE_KIMARO:expected');

    // Readable means unflagged, on the same report as an unreadable one: half a section is half
    // a section, exactly as a partly read report is still a report.
    expect(graceExpected?.amount).toBe(5_920_000);
    expect(graceExpected?.needsReview).toBe(false);
    expect(graceExpected?.confidence).toBe('HIGH');
  });

  it('keys a nameless row by its row number, not by how many fields precede it', () => {
    // Third row on the report, and the unreadable one above it wrote two fields rather than
    // three. `fields.length / 3 + 1` would have made this `attendant_2.666…`.
    expect(fieldOf(result.fields, 'attendant:attendant_3:expected')?.amount).toBe(1_800_000);
    expect(fieldOf(result.fields, 'attendant:attendant_3:collected')?.amount).toBe(1_700_000);
  });

  it('still asks for a person', () => {
    expect(result.status).toBe('NEEDS_REVIEW');
  });
});

describe('parseShiftReportText - partial failure', () => {
  const result = parseShiftReportText(REPORT_C);

  it('never reports a partially parsed report as FAILED', () => {
    // The point of the whole per-field design: half a report is half a report, not a
    // failure. A manager must be able to see which half arrived.
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.status).not.toBe('FAILED');
    expect(result.failureReason).toBeNull();
  });

  it('keeps the fields it did read', () => {
    expect(fieldOf(result.fields, 'bank_deposit_total')?.amount).toBe(5_000_000);
    expect(fieldOf(result.fields, 'mobile_money:M_PESA')?.amount).toBe(4_200_000);
    expect(fieldOf(result.fields, 'credit_sale:T_123_ABC')?.amount).toBe(850_000);
    expect(fieldOf(result.fields, 'attendant:JOHN_MWAKA:expected')?.amount).toBe(3_200_000);
  });

  it('flags a missing label instead of inventing or dropping it', () => {
    const cash = fieldOf(result.fields, 'cash_collected');
    expect(cash).toBeDefined();
    expect(cash?.rawValue).toBeNull();
    expect(cash?.parsedValue).toBeNull();
    expect(cash?.amount).toBeNull();
    expect(cash?.needsReview).toBe(true);
    expect(cash?.reviewNote).toMatch(/not found/i);
    expect(cash?.regionText).toBeNull();
  });

  it('flags a tank row whose closing dip is missing, and keeps the reading it has', () => {
    expect(fieldOf(result.fields, 'tank:1:book_stock')?.amount).toBe(12_000);
    const dip = fieldOf(result.fields, 'tank:1:closing_dip');
    expect(dip?.amount).toBeNull();
    expect(dip?.needsReview).toBe(true);
    expect(dip?.regionText).toBe('TANK 1 PMS 12,000');
  });

  it('leaves the variance uncomputed rather than computing it from a missing figure', () => {
    expect(result.summary.cash).toBeNull();
    expect(result.summary.variance).toBeNull();
    expect(result.summary.provisional).toBe(true);
  });
});

describe('parseShiftReportText - extracted text with no blank lines', () => {
  // Text extraction rebuilds lines from glyph positions, so an empty line — having no
  // glyphs — never reaches the parser. Every fixture above has blank lines in it; this one
  // deliberately does not, because that is the shape production actually delivers.
  //
  // It is here because the first version of the parser ended a section only at a blank
  // line, so the tank block ran straight on into the reconciliation note underneath it and
  // produced a tank called "CASHBACK". Against the blank-line fixtures that bug was
  // invisible.
  const REPORT_NO_BLANKS = [
    'PETRONITE FUEL STATION',
    'SHIFT REPORT',
    'Station: Main Station',
    'Date: 12/03/2026',
    'TOTALIZER SALES ................ 18,450,000',
    'CASH COLLECTED ................. 9,120,000',
    'BANK DEPOSITS .................. 5,000,000',
    'MOBILE MONEY',
    'M-Pesa ......................... 4,200,000',
    'CREDIT SALES',
    'T 123 ABC ...................... 850,000',
    'ATTENDANTS',
    'JOHN MWAKA ....... 3,200,000 3,150,000',
    'TANK DIP',
    'TANK 1 PMS 12,000 11,500',
    'TANK 2 AGO 8,000 7,800',
    'RECONCILIATION',
    'Cashback discount .............. 50,000',
  ].join('\n');

  const result = parseShiftReportText(REPORT_NO_BLANKS);

  it('still closes each section at the next heading', () => {
    expect(fieldOf(result.fields, 'tank:1:book_stock')?.amount).toBe(12_000);
    expect(fieldOf(result.fields, 'tank:1:closing_dip')?.amount).toBe(11_500);
    expect(fieldOf(result.fields, 'tank:2:closing_dip')?.amount).toBe(7_800);
    expect(fieldOf(result.fields, 'credit_sale:T_123_ABC')?.amount).toBe(850_000);
    expect(fieldOf(result.fields, 'attendant:JOHN_MWAKA:expected')?.amount).toBe(3_200_000);
  });

  it('does not let the tank block swallow the note printed under it', () => {
    // The exact failure: "Cashback discount" was read as a tank row, naming a tank after
    // the word CASHBACK and losing the discount as a reviewable adjustment.
    const tankNames = result.fields
      .filter((field) => field.group === 'TANK_READINGS')
      .map((field) => field.fieldName);
    expect(tankNames.some((name) => name.includes('CASHBACK'))).toBe(false);
    expect(tankNames).toHaveLength(4);

    const adjustment = fieldOf(result.fields, 'adjustment:CASHBACK_1');
    expect(adjustment?.amount).toBe(50_000);
    expect(adjustment?.needsReview).toBe(true);
  });

  it('reaches the same figures as the same report with blank lines', () => {
    const summary = result.summary;
    expect(summary.pumpTotalizerSales).toBe(18_450_000);
    expect(summary.cash).toBe(9_120_000);
    expect(summary.mobileMoney).toBe(4_200_000);
    expect(summary.approvedCredit).toBe(850_000);
    expect(summary.variance).toBe(18_450_000 - (9_120_000 + 4_200_000 + 850_000));
  });
});

describe('parseShiftReportText - wrong document', () => {
  it('fails a document that is not a shift report, and says why', () => {
    const result = parseShiftReportText(REPORT_D);

    expect(result.status).toBe('FAILED');
    expect(result.fields).toEqual([]);
    expect(result.failureReason).toMatch(/does not match the Petronite shift report template/i);
    expect(result.failureReason).toMatch(/markers/i);
  });

  it('names the markers it did and did not find', () => {
    const result = parseShiftReportText(REPORT_D);
    expect(result.diagnostics.matchedMarkers.length).toBeLessThan(3);
    expect(result.diagnostics.missingMarkers).toContain('PETRONITE');
  });

  it('fails a document that has the markers but no readable figures', () => {
    const result = parseShiftReportText('PETRONITE\nSHIFT REPORT\nTOTALIZER\nAll values in TZS\n');

    expect(result.status).toBe('FAILED');
    expect(result.failureReason).toMatch(/no fields could be extracted/i);
  });

  it('fails an empty document with an explanation rather than empty data', () => {
    const result = parseShiftReportText('   \n\n  \n');

    expect(result.status).toBe('FAILED');
    // Empty text is what a scan produces as well as what a blank document does, so the
    // message has to name both causes and what to do about each — see the integration
    // suite, which drives the same branch through a real image-only PDF.
    expect(result.failureReason).toMatch(/no text could be read/i);
    expect(result.failureReason).toMatch(/scan or a photograph/i);
    expect(result.fields).toEqual([]);
  });
});
