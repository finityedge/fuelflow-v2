/**
 * Unit tests for the tank reading arithmetic.
 *
 * The subtraction here is one line long and the whole module turns on it, so the tests are
 * about the two ways it can be wrong rather than about the arithmetic: the *sign* — book above
 * dip means fuel is missing — and the treatment of a missing figure, which must never be read
 * as zero.
 */

import { describe, expect, it } from 'vitest';
import { tankReadingsFromFields } from '../../src/parsing/tankVariance.js';
import type { SummaryInput } from '../../src/parsing/types.js';

function field(
  fieldName: string,
  amount: number | null,
  needsReview = false
): SummaryInput {
  return { fieldName, amount, needsReview };
}

describe('tankReadingsFromFields', () => {
  it('pairs a book figure with its dip and takes book minus dip', () => {
    const readings = tankReadingsFromFields([
      field('tank:TANK_1:book_stock', 12_000),
      field('tank:TANK_1:closing_dip', 11_500),
    ]);

    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({
      slug: 'TANK_1',
      bookStock: 12_000,
      closingDip: 11_500,
      varianceLitres: 500,
    });
  });

  it('reports a surplus as negative, so only a positive number means fuel is missing', () => {
    // The direction is the one thing a reader of the screen will assume without checking.
    // If a tank holding more than its paperwork claims came back positive it would head the
    // leak list, and the screen would be accusing the most honest tank on the station.
    const readings = tankReadingsFromFields([
      field('tank:TANK_2:book_stock', 8_000),
      field('tank:TANK_2:closing_dip', 8_400),
    ]);

    expect(readings[0]!.varianceLitres).toBe(-400);
  });

  it('leaves the variance null when the dip is missing, rather than treating it as zero', () => {
    // A missing dip scored as 0 L would invent a loss the size of the whole book figure —
    // 12,000 litres on the tank below — and put a station's best tank at the top of the
    // leak list on the strength of a blank cell.
    const readings = tankReadingsFromFields([field('tank:TANK_1:book_stock', 12_000)]);

    expect(readings[0]).toMatchObject({ bookStock: 12_000, closingDip: null, varianceLitres: null });
  });

  it('leaves the variance null when the book figure is missing', () => {
    const readings = tankReadingsFromFields([field('tank:TANK_1:closing_dip', 11_500)]);

    expect(readings[0]).toMatchObject({ bookStock: null, closingDip: 11_500, varianceLitres: null });
  });

  it('marks a reading provisional when either side still needs review', () => {
    const flagged = tankReadingsFromFields([
      field('tank:TANK_1:book_stock', 12_000, true),
      field('tank:TANK_1:closing_dip', 11_500),
    ]);
    const clean = tankReadingsFromFields([
      field('tank:TANK_1:book_stock', 12_000),
      field('tank:TANK_1:closing_dip', 11_500),
    ]);

    expect(flagged[0]!.provisional).toBe(true);
    expect(clean[0]!.provisional).toBe(false);
  });

  it('keeps the tanks in the order the report printed them', () => {
    // The reader has the paper in front of them; a list that reorders itself makes them hunt.
    const readings = tankReadingsFromFields([
      field('tank:TANK_3:book_stock', 300),
      field('tank:TANK_1:book_stock', 100),
      field('tank:TANK_2:book_stock', 200),
    ]);

    expect(readings.map((reading) => reading.slug)).toEqual(['TANK_3', 'TANK_1', 'TANK_2']);
  });

  it('ignores fields that are not tank readings', () => {
    const readings = tankReadingsFromFields([
      field('cash_collected', 9_120_000),
      field('credit_sale:T123ABC', 850_000),
      field('attendant:JOHN_MWAKA:expected', 3_200_000),
      field('tank:TANK_1:book_stock', 12_000),
    ]);

    expect(readings.map((reading) => reading.slug)).toEqual(['TANK_1']);
  });

  it('ignores a tank reading it does not know how to use', () => {
    // An opening dip or a delivery figure added to the section later must not be mistaken
    // for a closing one and silently replace the figure the variance is built from.
    const readings = tankReadingsFromFields([
      field('tank:TANK_1:opening_dip', 9_000),
      field('tank:TANK_1:book_stock', 12_000),
      field('tank:TANK_1:closing_dip', 11_500),
    ]);

    expect(readings).toHaveLength(1);
    expect(readings[0]!.closingDip).toBe(11_500);
    expect(readings[0]!.varianceLitres).toBe(500);
  });

  it('ignores a field name that is not shaped like a tank reading', () => {
    const readings = tankReadingsFromFields([
      field('tank:', 1),
      field('tank:TANK_1', 2),
      field('tank:TANK_1:book_stock:extra', 3),
      field('tank:TANK_1:book_stock', 12_000),
    ]);

    expect(readings.map((reading) => reading.slug)).toEqual(['TANK_1']);
  });

  it('returns nothing for a report with no tank section', () => {
    expect(tankReadingsFromFields([field('cash_collected', 100)])).toEqual([]);
  });
});
