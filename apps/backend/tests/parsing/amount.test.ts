import { describe, expect, it } from 'vitest';
import { findAmounts, hasDigit, parseAmount } from '../../src/parsing/amount.js';

describe('parseAmount', () => {
  it('reads plain and thousands-separated figures', () => {
    expect(parseAmount('1234')).toBe(1234);
    expect(parseAmount('1,234,567')).toBe(1234567);
    expect(parseAmount('1 234 567')).toBe(1234567);
    expect(parseAmount('1,234.50')).toBe(1234.5);
  });

  it('reads the accounting negative and the trailing-minus negative', () => {
    expect(parseAmount('(1,234)')).toBe(-1234);
    expect(parseAmount('1,234-')).toBe(-1234);
    expect(parseAmount('-1,234')).toBe(-1234);
  });

  it('rejects things that are not numbers', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('PMS')).toBeNull();
    expect(parseAmount('......')).toBeNull();
    // Two figures run together is not one figure, and guessing would be worse than
    // flagging the field.
    expect(parseAmount('1,234 567')).toBe(1234567);
  });
});

describe('findAmounts', () => {
  it('finds every figure in printed order', () => {
    expect(findAmounts('JOHN MWAKA 3,200,000 3,150,000').map((m) => m.amount)).toEqual([
      3200000, 3150000,
    ]);
  });

  it('ignores currency noise and dot leaders', () => {
    expect(findAmounts('CASH COLLECTED ...... TZS 9,120,000').map((m) => m.amount)).toEqual([9120000]);
    expect(findAmounts('TOTAL ......... 18,450,000.00').map((m) => m.amount)).toEqual([18450000]);
  });

  it('keeps a dotted figure as one number rather than splitting it', () => {
    expect(findAmounts('1,234,567.00')).toHaveLength(1);
  });

  it('returns nothing for a heading', () => {
    expect(findAmounts('TANK DIP READINGS')).toEqual([]);
  });

  it('keeps the literal text each figure was read from', () => {
    expect(findAmounts('(1,234)')[0]).toEqual({ raw: '(1,234)', amount: -1234 });
  });
});

describe('hasDigit', () => {
  it('tells a data row from a heading', () => {
    expect(hasDigit('TANK 1')).toBe(true);
    expect(hasDigit('TANK DIP')).toBe(false);
  });
});
