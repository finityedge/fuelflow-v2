/**
 * Parser tests.
 *
 * NOTE ON THE FIXTURES: the fixtures below this line were synthesised to the structure the
 * product spec describes, with the spacing varied between them so the template tolerance is
 * actually exercised. Every figure in them is invented.
 *
 * A real report has since been seen, and the block at the end of this file is about it — but it
 * is a different layout from the invented ones, not a variation on them (the totalizer line is
 * absent, the attendant block has an extra column, the tank table has seven figures per row,
 * and cash sales are itemised per product). The two sets of fixtures are therefore kept
 * side by side and neither is treated as the template: the invented ones above cover the shapes
 * the spec describes, and the real one is the shape a station actually prints.
 *
 * That real report is not in this file, and not in the repository at all: it is a live station's
 * figures with the people's real names and a real bank account number on it. It is loaded from a
 * gitignored sample by `tests/helpers/realReport.ts`, and the block that uses it skips itself on a
 * checkout that does not have the file.
 */

import { describe, expect, it } from 'vitest';
import { parseShiftReportText, computeSummary } from '../../src/parsing/petronite.js';
import type { ParsedField } from '../../src/parsing/types.js';
import { realShiftReportSample, sampleMissing } from '../helpers/realReport.js';

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

/**
 * The real report.
 *
 * Everything above this block was written against invented fixtures, because no real Petronite
 * report was available. One is now, and it does not have the shape those fixtures have. The
 * assertions here are what pins the parser to it, and the arithmetic they check is the report's
 * own: the figures on it agree with each other in three places, so a column read from the wrong
 * position breaks at least one of them.
 *
 * The report itself is not in the repository — it carries real people's names and a real bank
 * account number — so it is loaded from a gitignored file by `tests/helpers/realReport.ts`, and
 * this block skips itself where that file is absent. Skipped is the honest outcome: the parser's
 * fit to the real layout is unverified on such a machine, and a green suite must not imply
 * otherwise. What a machine with the sample gets is the whole block below.
 */
describe.skipIf(sampleMissing)('parseShiftReportText - the real Petronite report', () => {
  // Parsed from the empty string when the sample is absent. The block is skipped in that case, so
  // nothing reads it; it is written this way so registering the tests never dereferences a null.
  const result = parseShiftReportText(realShiftReportSample ?? '');

  it('reads the document as a shift report for its own date', () => {
    expect(result.diagnostics.matchedMarkers.length).toBeGreaterThanOrEqual(3);
    expect(result.reportDate).toBe('2026-08-24');
    expect(result.failureReason).toBeNull();
  });

  it('reads the three attendants, and no one else', () => {
    const expected = result.fields.filter((field) => field.fieldName.endsWith(':expected'));

    expect(expected.map((field) => field.fieldName)).toEqual([
      'attendant:AMINA_MOHAMMED_SHARIF:expected',
      'attendant:RAHMA_HAMISI:expected',
      'attendant:ZAINABU_SELEMANI:expected',
    ]);
  });

  it('takes the amount to collect as what is owed, not the amount spent beside it', () => {
    // The row is `AMINA MOHAMMED SHARIF DAY 0 1,510,434.37 1,510,400.00 -34.37`. Read the way
    // the older three-column layout reads — first figure owed, second collected — the 0 spent
    // is the money she owes and 1,510,434.37 is what she handed in.
    expect(fieldOf(result.fields, 'attendant:AMINA_MOHAMMED_SHARIF:expected')?.amount).toBe(1510434.37);
    expect(fieldOf(result.fields, 'attendant:AMINA_MOHAMMED_SHARIF:collected')?.amount).toBe(1510400);
  });

  it('drops the shift word from the name, so a person is one key on days and on nights', () => {
    expect(fieldOf(result.fields, 'attendant:AMINA_MOHAMMED_SHARIF:variance')?.label).toBe(
      'AMINA MOHAMMED SHARIF - variance'
    );
    expect(result.fields.some((field) => field.fieldName.includes('_DAY'))).toBe(false);
  });

  it('records a shortfall as a shortfall, in this product\'s sign', () => {
    // The report prints `-34.37` in its own Loss/Gain column for the same fact. Stored as
    // printed it would read as a surplus on every screen that shows a variance.
    const variance = fieldOf(result.fields, 'attendant:AMINA_MOHAMMED_SHARIF:variance');

    expect(variance?.amount).toBeCloseTo(34.37, 2);
    expect(variance?.needsReview).toBe(false);
  });

  it('does not invent an attendant out of the block total', () => {
    expect(result.fields.some((field) => field.fieldName.startsWith('attendant:TOTAL'))).toBe(false);
  });

  it('reads the book stock and closing dip from the middle of the stock movement row', () => {
    // `AGO 3 954.054 0 0 192.597 761.457 762.162 0.705` — opening balance first, and the
    // report's own variance of 0.705 at the end. Read positionally as the older two-figure
    // layout reads them, this tank's book stock is 954.054 and its dip is 0.
    expect(fieldOf(result.fields, 'tank:AGO_3:book_stock')?.amount).toBe(761.457);
    expect(fieldOf(result.fields, 'tank:AGO_3:closing_dip')?.amount).toBe(762.162);
    expect(fieldOf(result.fields, 'tank:AGO_4:book_stock')?.amount).toBe(29182.308);
    expect(fieldOf(result.fields, 'tank:PMS:book_stock')?.amount).toBe(5447.367);
  });

  it('keeps the tank number that is part of the tank name', () => {
    const tanks = result.fields
      .filter((field) => field.fieldName.endsWith(':book_stock'))
      .map((field) => field.fieldName.replace('tank:', '').replace(':book_stock', ''));

    expect(tanks).toEqual(['AGO_1', 'AGO_2', 'AGO_3', 'AGO_4', 'PMS']);
  });

  it('reads a credit sale as its money, not as the quantity in front of the pump names', () => {
    // `OILCOM T LTD MC863FJY 12 PUMP 1 - PUMP 2 - S1 3,917.00 47,004.00`. The first figure
    // after the vehicle is the litres; the money is last.
    expect(fieldOf(result.fields, 'credit_sale:MC863FJY')?.amount).toBe(47004);
    expect(fieldOf(result.fields, 'credit_sale:T303EQU')?.amount).toBe(799600);
    expect(
      result.fields
        .filter((field) => field.fieldName.startsWith('credit_sale:'))
        .reduce((sum, field) => sum + (field.amount ?? 0), 0)
    ).toBeCloseTo(905359, 2);
  });

  it('does not read the credit block total as a credit sale', () => {
    expect(result.fields.some((field) => field.fieldName === 'credit_sale:TOTAL')).toBe(false);
    expect(result.fields.filter((field) => field.fieldName.startsWith('credit_sale:'))).toHaveLength(5);
  });

  it('reads each product\'s cash takings from the cash sales block', () => {
    expect(fieldOf(result.fields, 'cash_sales:AGO_DIESEL')?.amount).toBe(2009382.81);
    expect(fieldOf(result.fields, 'cash_sales:PMS_MSP_PETROL')?.amount).toBe(2030925.33);
  });

  it('reads cash collected from the cash position line, not the amount still to be collected', () => {
    expect(fieldOf(result.fields, 'cash_collected')?.amount).toBe(4040200);
    expect(fieldOf(result.fields, 'cash_collected')?.needsReview).toBe(false);
  });

  it('reads the bank deposit from the account line', () => {
    expect(fieldOf(result.fields, 'bank_deposit_total')?.amount).toBe(160000);
  });

  it('reads the expense once, and its money rather than the litres glued to a word', () => {
    const adjustments = result.fields.filter((field) => field.fieldName.startsWith('adjustment:'));

    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].amount).toBe(15100);
    // `Discounts & Bonuses CASHBACK DISCOUNT LTRS310 15,100.00` — the 310 is litres.
    expect(adjustments[0].reviewNote).toMatch(/always require review/i);
  });

  it('adds the total sales up from the blocks that itemise them', () => {
    // 4,040,308.14 of cash sales + 905,359.00 on credit. The report prints no totalizer line,
    // so this is derived on every read, and it is the figure the variance is measured against.
    expect(result.summary.pumpTotalizerSales).toBeCloseTo(4945667.14, 2);
  });

  it('stores no totalizer field, because a stored derived figure goes stale', () => {
    // The label scan matches the `Total Sales` column heading, so without dropping it there
    // would be a flagged, empty row asking a manager for a figure the report never printed.
    expect(
      result.fields.filter((field) => field.fieldName.startsWith('pump_totalizer_sales'))
    ).toHaveLength(0);
  });

  it('moves the total, and the variance with it, when a product cash figure is corrected', () => {
    // The reason the total is derived rather than stored. Correcting a component has to reach
    // the headline number, or a shift corrected from a shortfall to a surplus goes on showing
    // the shortfall — which is what a stored total would do.
    const fields = result.fields.map((field) => ({ ...field }));
    const diesel = fields.find((field) => field.fieldName === 'cash_sales:AGO_DIESEL');
    expect(diesel?.amount).toBeCloseTo(2009382.81, 2);
    const before = computeSummary(fields);

    diesel!.amount = 2_000_000;
    const after = computeSummary(fields);

    expect(before.pumpTotalizerSales! - after.pumpTotalizerSales!).toBeCloseTo(9382.81, 2);
    expect(after.variance! - before.variance!).toBeCloseTo(-9382.81, 2);
  });

  it('agrees with the report about how much money is missing', () => {
    // The report prints `TOTAL ATTENDANT LOSS/GAIN -108.14`, and `AMOUNT TO BE COLLECTED
    // 4,040,308.14` against `AMOUNT COLLECTED 4,040,200.00`. The variance below is the second
    // of those facts, arrived at independently: total sales less what was collected and what
    // is on credit.
    expect(result.summary.variance).toBeCloseTo(108.14, 2);
    expect(result.summary.pumpTotalizerSales).toBeCloseTo(4945667.14, 2);
    expect(result.summary.cash).toBe(4040200);
    expect(result.summary.approvedCredit).toBeCloseTo(905359, 2);
  });

  it('ties the total sales to the pump litres valued at their own unit prices', () => {
    // 702.597 x 3,998.00 + 545.49 x 3,917.00. This is the report's own arithmetic, not the
    // parser's, and it is the tie that catches a cash sales row read one column off.
    expect(result.summary.pumpTotalizerSales).toBeCloseTo(702.597 * 3998 + 545.49 * 3917, 2);
  });

  it('has a complete enough reading to call the summary provisional no longer', () => {
    expect(result.summary.provisional).toBe(false);
  });

  it('asks a manager to review the manual entry and nothing else', () => {
    // The one flagged field is the expense, which is flagged by rule on every report. Every
    // figure read off the document itself is high confidence and unattended.
    const flagged = result.fields.filter((field) => field.needsReview);

    expect(flagged.map((field) => field.fieldName)).toEqual(['adjustment:CASHBACK_1']);
    expect(result.status).toBe('NEEDS_REVIEW');
  });
});
