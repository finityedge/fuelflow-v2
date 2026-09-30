/**
 * Unit tests for the attendant variance arithmetic.
 *
 * Three things here carry more weight than the subtraction.
 *
 * The **sign**: `expected - collected`, so a positive number is money that was due and not
 * handed over. Read backwards, every person this product points at would be pointed at for
 * handing over *more* than they owed.
 *
 * The **missing figure**: an unreadable collected amount is null and never zero. A zero here
 * invents a shortfall the size of the whole day's takings, on a named person's record.
 *
 * The **unused variance column**: the parser also writes `attendant:<slug>:variance`, and this
 * module deliberately does not read it. A test pins that, because the field exists and is the
 * obvious thing to reach for — and reaching for it would silently detach the profile from the
 * correction screen, since a manager fixes `collected`, not the printed variance.
 */

import { describe, expect, it } from 'vitest';
import { attendantReadingsFromFields } from '../../src/parsing/attendantVariance.js';
import type { AttendantFieldInput } from '../../src/parsing/attendantVariance.js';

function field(
  fieldName: string,
  amount: number | null,
  options: { label?: string | null; needsReview?: boolean } = {}
): AttendantFieldInput {
  return {
    fieldName,
    amount,
    needsReview: options.needsReview ?? false,
    label: options.label ?? null,
  };
}

describe('attendantReadingsFromFields', () => {
  it('pairs what was due with what was handed over and takes expected minus collected', () => {
    const readings = attendantReadingsFromFields([
      field('attendant:JOHN_MWAKA:expected', 3_200_000, { label: 'JOHN MWAKA - to collect' }),
      field('attendant:JOHN_MWAKA:collected', 3_150_000, { label: 'JOHN MWAKA - collected' }),
    ]);

    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({
      slug: 'JOHN_MWAKA',
      expected: 3_200_000,
      collected: 3_150_000,
      variance: 50_000,
      label: 'JOHN MWAKA',
    });
  });

  it('reports a surplus as negative, so only a positive number means money is missing', () => {
    // A person who handed over more than they were due must not appear at the top of a list
    // of people suspected of taking money. This is the assertion that stops that.
    const readings = attendantReadingsFromFields([
      field('attendant:GRACE_KIMARO:expected', 5_920_000),
      field('attendant:GRACE_KIMARO:collected', 5_970_000),
    ]);

    expect(readings[0]!.variance).toBe(-50_000);
  });

  it('leaves the variance null when the collected figure is missing, rather than treating it as zero', () => {
    // Zero would read as "handed over nothing" — a shortfall the size of the entire shift's
    // takings, entered against a named person, caused by a blank cell.
    const readings = attendantReadingsFromFields([
      field('attendant:JOHN_MWAKA:expected', 3_200_000),
    ]);

    expect(readings[0]).toMatchObject({
      expected: 3_200_000,
      collected: null,
      variance: null,
    });
  });

  it('leaves the variance null when the expected figure is missing', () => {
    const readings = attendantReadingsFromFields([
      field('attendant:JOHN_MWAKA:collected', 3_150_000),
    ]);

    expect(readings[0]).toMatchObject({ expected: null, collected: 3_150_000, variance: null });
  });

  it('ignores the variance column the parser also writes', () => {
    // The report printed a variance of 10,000 where the two figures above it say 50,000. The
    // module must return the derivable 50,000: that is the number a manager can move by
    // correcting `collected`, and the number the review screen shows.
    const readings = attendantReadingsFromFields([
      field('attendant:JOHN_MWAKA:expected', 3_200_000),
      field('attendant:JOHN_MWAKA:collected', 3_150_000),
      field('attendant:JOHN_MWAKA:variance', 10_000, { label: 'JOHN MWAKA - variance' }),
    ]);

    expect(readings).toHaveLength(1);
    expect(readings[0]!.variance).toBe(50_000);
  });

  it('marks a reading provisional while either of its figures is still flagged', () => {
    const readings = attendantReadingsFromFields([
      field('attendant:JOHN_MWAKA:expected', 3_200_000, { needsReview: true }),
      field('attendant:JOHN_MWAKA:collected', 3_150_000),
    ]);

    expect(readings[0]!.provisional).toBe(true);
  });

  it('keeps the report’s own attendant order', () => {
    // The screen is read next to the paper a manager is holding, so a list that came back in
    // some other order would be quietly harder to check against it.
    const readings = attendantReadingsFromFields([
      field('attendant:JOHN_MWAKA:expected', 100),
      field('attendant:JOHN_MWAKA:collected', 90),
      field('attendant:GRACE_KIMARO:expected', 200),
      field('attendant:GRACE_KIMARO:collected', 200),
      field('attendant:PETER_JOHN:expected', 300),
      field('attendant:PETER_JOHN:collected', 250),
    ]);

    expect(readings.map((reading) => reading.slug)).toEqual([
      'JOHN_MWAKA',
      'GRACE_KIMARO',
      'PETER_JOHN',
    ]);
  });

  it('reads the printed name off the label, without the trailing description', () => {
    const readings = attendantReadingsFromFields([
      field('attendant:J_MWANGI:expected', 100, { label: 'J. Mwangi - to collect' }),
      field('attendant:J_MWANGI:collected', 90, { label: 'J. Mwangi - collected' }),
    ]);

    expect(readings[0]!.label).toBe('J. Mwangi');
  });

  it('leaves the label null rather than guessing where a name stops', () => {
    // A row the parser could not split still carries a figure. Nothing about it says where
    // the name ended, and a guess would put an invented name in front of a manager.
    const readings = attendantReadingsFromFields([
      field('attendant:JOHN_MWAKA:expected', 100, { label: 'JOHN MWAKA 3,200,000' }),
      field('attendant:JOHN_MWAKA:collected', 90),
    ]);

    expect(readings[0]!.label).toBeNull();
  });

  it('skips a row-level flag, which has no expected or collected figure', () => {
    /*
     * The legacy shape — what the parser used to write for a row whose two figures could not be
     * told apart, and what reports parsed before that change still carry. New rows arrive as an
     * `expected` and a `collected` with null amounts instead (see the parser tests), which this
     * module *does* read, as a reading with an unknown figure.
     *
     * Kept because the old rows are still in the database, and because it pins the rule that
     * matters either way: a figure that could not be attributed to a column is never counted as
     * one. The 3,200,000 below is deliberately attached to the row-level field — if this module
     * ever picked it up, the amount would be scored into somebody's variance as an expected
     * figure purely because of where it was filed.
     */
    const readings = attendantReadingsFromFields([
      field('attendant:JOHN_MWAKA:row', 3_200_000, {
        label: 'JOHN MWAKA - unreadable row',
        needsReview: true,
      }),
    ]);

    expect(readings).toEqual([]);
  });

  it('reads the two empty fields of an unreadable row as a shift with no figures', () => {
    // The shape the parser writes now: both figures present, both empty. The person *was* on the
    // report, so this is a shift that cannot be compared rather than one that never happened —
    // which is what the null variance and `provisional` say to the profile downstream.
    const readings = attendantReadingsFromFields([
      field('attendant:JOHN_MWAKA:expected', null, {
        label: 'JOHN MWAKA - to collect',
        needsReview: true,
      }),
      field('attendant:JOHN_MWAKA:collected', null, {
        label: 'JOHN MWAKA - collected',
        needsReview: true,
      }),
    ]);

    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({
      slug: 'JOHN_MWAKA',
      expected: null,
      collected: null,
      variance: null,
      provisional: true,
      label: 'JOHN MWAKA',
    });
  });

  it('skips field names that are not attendant readings', () => {
    const readings = attendantReadingsFromFields([
      field('cash_collected', 1_000),
      field('tank:TANK_1:book_stock', 12_000),
      field('attendant:', 1),
      field('attendant:JOHN_MWAKA', 1),
      field('attendant:JOHN_MWAKA:a:b', 1),
    ]);

    expect(readings).toEqual([]);
  });
});
