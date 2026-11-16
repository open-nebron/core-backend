import { describe, it, expect } from 'vitest';
import { isValidDobAtLeast13, patchMeSchema } from '../../src/modules/profiles/profile.schema.js';

describe('Date of Birth Age >= 13 Rules', () => {
  it('accepts adults and users well above 13 years old', () => {
    expect(isValidDobAtLeast13('1990-05-15')).toBe(true);
    expect(isValidDobAtLeast13('2000-01-01')).toBe(true);
  });

  it('accepts user who is exactly 13 years old today', () => {
    const today = new Date();
    const exactly13YearsAgo = new Date(
      Date.UTC(today.getUTCFullYear() - 13, today.getUTCMonth(), today.getUTCDate())
    );
    const dobStr = exactly13YearsAgo.toISOString().split('T')[0];
    expect(isValidDobAtLeast13(dobStr)).toBe(true);
  });

  it('rejects user who is turning 13 tomorrow (younger than 13)', () => {
    const today = new Date();
    const tomorrowMinus13 = new Date(
      Date.UTC(today.getUTCFullYear() - 13, today.getUTCMonth(), today.getUTCDate() + 1)
    );
    const dobStr = tomorrowMinus13.toISOString().split('T')[0];
    expect(isValidDobAtLeast13(dobStr)).toBe(false);
  });

  it('rejects users clearly younger than 13 (e.g. 5 years old)', () => {
    const today = new Date();
    const fiveYearsAgo = new Date(
      Date.UTC(today.getUTCFullYear() - 5, today.getUTCMonth(), today.getUTCDate())
    );
    const dobStr = fiveYearsAgo.toISOString().split('T')[0];
    expect(isValidDobAtLeast13(dobStr)).toBe(false);
  });

  it('rejects future dates', () => {
    const today = new Date();
    const future = new Date(
      Date.UTC(today.getUTCFullYear() + 1, today.getUTCMonth(), today.getUTCDate())
    );
    const dobStr = future.toISOString().split('T')[0];
    expect(isValidDobAtLeast13(dobStr)).toBe(false);
  });

  it('rejects dates older than 120 years', () => {
    expect(isValidDobAtLeast13('1850-01-01')).toBe(false);
  });

  it('rejects invalid calendar dates (e.g. Feb 31)', () => {
    expect(isValidDobAtLeast13('2000-02-31')).toBe(false);
  });

  it('rejects malformed date strings', () => {
    expect(isValidDobAtLeast13('2000/01/01')).toBe(false);
    expect(isValidDobAtLeast13('01-01-2000')).toBe(false);
    expect(isValidDobAtLeast13('not-a-date')).toBe(false);
    expect(isValidDobAtLeast13('')).toBe(false);
  });

  it('validates via patchMeSchema', () => {
    // Valid DOB
    const valid = patchMeSchema.safeParse({ dateOfBirth: '2000-01-01' });
    expect(valid.success).toBe(true);

    // Too young DOB
    const today = new Date();
    const tooYoung = new Date(
      Date.UTC(today.getUTCFullYear() - 10, today.getUTCMonth(), today.getUTCDate())
    ).toISOString().split('T')[0];
    const invalid = patchMeSchema.safeParse({ dateOfBirth: tooYoung });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues[0].message).toContain('at least 13 years old');
    }
  });
});
