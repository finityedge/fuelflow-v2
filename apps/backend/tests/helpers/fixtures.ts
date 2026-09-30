/**
 * The report text the parser tests and the integration tests both work from.
 *
 * These live here rather than inline in the integration test so a PDF built for a manual
 * walkthrough is the *same* document the suite asserts against. If the fixtures drifted
 * apart, the walkthrough could pass while the tests failed, or the reverse, and neither
 * would tell you anything about the other.
 *
 * No real Petronite shift report was available when these were written, so the structure
 * and wording are reconstructed from the spec rather than captured from a live station.
 * They exercise the parser; they do not prove it against real reports.
 */

/**
 * A tidy report, as a PDF would yield it.
 *
 * Deliberately written without blank lines: the text-extraction step reconstructs lines
 * from glyph positions and drops anything empty, so a blank line in the source document
 * does not survive into the text the parser sees. Writing this fixture with blank lines
 * would have tested a document the pipeline can never actually produce.
 */
export const TIDY_REPORT_LINES = [
  'PETRONITE FUEL STATION',
  'SHIFT REPORT',
  'Station: Main Station',
  'Date: 12/03/2026',
  'Shift: Day',
  'TOTALIZER SALES ................ 18,450,000',
  'CASH COLLECTED ................. 9,120,000',
  'BANK DEPOSITS .................. 5,000,000',
  'MOBILE MONEY',
  'M-Pesa ......................... 4,200,000',
  'Tigo Pesa ...................... 1,130,000',
  'CREDIT SALES',
  'T 123 ABC ...................... 850,000',
  'T 456 DEF ...................... 150,000',
  'ATTENDANTS',
  'JOHN MWAKA ....... 3,200,000 3,150,000',
  'GRACE KIMARO ..... 5,920,000 5,970,000',
  'TANK DIP',
  'TANK 1 PMS 12,000 11,500',
  'TANK 2 AGO 8,000 7,800',
  'RECONCILIATION',
  'Cashback discount .............. 50,000',
];

/** The same report with the totalizer, the cash line and a tank dip reading missing. */
export const PARTIAL_REPORT_LINES = [
  'PETRONITE FUEL STATION',
  'SHIFT REPORT',
  'Station: Main Station',
  'Date: 2026-03-14',
  'BANK DEPOSITS .................. 5,000,000',
  'MOBILE MONEY',
  'M-Pesa ......................... 4,200,000',
  'CREDIT SALES',
  'T 123 ABC ...................... 850,000',
  'ATTENDANTS',
  'JOHN MWAKA ....... 3,200,000 3,150,000',
  'TANK DIP',
  'TANK 1 PMS 12,000',
  'RECONCILIATION',
];

/**
 * A tidy report with two manual entries rather than one.
 *
 * Every manual expense, discount or write-off is flagged on purpose, every time: they are the
 * entries nothing else on the report can corroborate. That makes them the smallest document
 * that puts *two* flagged figures on the review screen at once — the case a batch acceptance
 * exists for, and the one no other fixture covers.
 */
export const TWO_ADJUSTMENTS_REPORT_LINES = [
  ...TIDY_REPORT_LINES,
  'Shift expense .................. 25,000',
];

/**
 * A report that is both short-read and manually adjusted.
 *
 * The single state a batch has to be able to report honestly: figures with something to sign
 * off as read, and figures with nothing read to sign off at all, arriving in one request.
 */
export const MIXED_REPORT_LINES = [
  ...PARTIAL_REPORT_LINES,
  'Cashback discount .............. 50,000',
];

/** A document that is not a shift report at all. */
export const NOT_A_REPORT_LINES = [
  'INVOICE 4471',
  'Supplier: Some Other Vendor Ltd',
  'Amount due: 1,200,000',
  'Payment terms: 30 days',
];
