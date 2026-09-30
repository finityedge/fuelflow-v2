/**
 * Tests for the key a printed label becomes.
 *
 * `slugify` had no tests before this file, and the gap matters because the function is the one
 * contract two independent screens have to satisfy without ever calling each other: the parser
 * reads a label off a PDF and station settings reads one a human typed, and a tank or an
 * attendant only ever matches a report if both arrive at the same string.
 */

import { describe, expect, it } from 'vitest';
import { slugify, tankIdentity } from '../../src/parsing/slug.js';

describe('slugify', () => {
  it('uppercases and joins words with underscores', () => {
    expect(slugify('Tank 1')).toBe('TANK_1');
    expect(slugify('J. Mwangi')).toBe('J_MWANGI');
    expect(slugify('John  Mwangi')).toBe('JOHN_MWANGI');
  });

  it('trims punctuation off the ends rather than leaving blank segments', () => {
    expect(slugify('  Tank 2  ')).toBe('TANK_2');
    expect(slugify('-Tank-2-')).toBe('TANK_2');
  });

  it('caps the key so a long printed label cannot overflow the column', () => {
    expect(slugify('A'.repeat(100))).toHaveLength(40);
  });

  it('returns an empty string for a label with nothing usable in it', () => {
    // Callers treat this as a rejected input rather than as a key; see `createTank`.
    expect(slugify('   ')).toBe('');
    expect(slugify('***')).toBe('');
  });
});

describe('tankIdentity', () => {
  it('makes the parser’s spelling and the settings screen’s spelling the same tank', () => {
    // The mismatch this exists for: a report prints `TANK 1 PMS ...` and the parser keys it
    // `1`, while settings turns the typed name "Tank 1" into `TANK_1`. Neither is wrong and
    // they can never meet on their own.
    expect(tankIdentity('1')).toBe(tankIdentity('TANK_1'));
    expect(tankIdentity('TANK 1')).toBe(tankIdentity('TANK_1'));
    expect(tankIdentity('10')).toBe(tankIdentity('TANK_10'));
  });

  it('treats a lettered tank the same way', () => {
    expect(tankIdentity('A')).toBe('A');
    expect(tankIdentity('TANK_A')).toBe('A');
  });

  it('does not equate two different tanks', () => {
    expect(tankIdentity('TANK_1')).not.toBe(tankIdentity('TANK_10'));
    expect(tankIdentity('TANK_1')).not.toBe(tankIdentity('TANK_2'));
  });

  it('keeps a slug that is only the word TANK from collapsing into every other one', () => {
    // Stripping this leaves nothing, and returning the empty string would make every such
    // slug identical — so the first one indexed would answer for all of them.
    expect(tankIdentity('TANK')).toBe('TANK');
    expect(tankIdentity('TANK')).not.toBe(tankIdentity('TANK_1'));
  });

  it('leaves an already-bare identity alone', () => {
    expect(tankIdentity('2')).toBe('2');
  });

  it('does not cut the letters out of a label that merely starts with TANK', () => {
    // A tank named "Tanker 1" is not a tank called anything 1. Stripping on the letters alone
    // would key it `ER1` and collide with nothing, which is worse than failing to match — it
    // would look like a match to something else.
    expect(tankIdentity('TANKER_1')).toBe('TANKER1');
    expect(tankIdentity('TANKER_1')).not.toBe('1');
  });
});
