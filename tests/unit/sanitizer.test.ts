import { describe, it, expect } from 'vitest';
import { sanitizeName, sanitizeBio } from '../../src/utils/sanitizer.js';

describe('Sanitizer Utils', () => {
  it('strips control characters from name', () => {
    const raw = 'John\x00\x07Doe\x1F';
    expect(sanitizeName(raw)).toBe('JohnDoe');
  });

  it('strips newlines and tabs from name', () => {
    const raw = 'John\n\tDoe\r';
    expect(sanitizeName(raw)).toBe('JohnDoe');
  });

  it('trims whitespace around name', () => {
    expect(sanitizeName('   Alice Smith   ')).toBe('Alice Smith');
  });

  it('preserves line breaks and tabs in bio while stripping other control characters', () => {
    const bio = 'Line 1\nLine 2\tTabbed\x00\x08End';
    expect(sanitizeBio(bio)).toBe('Line 1\nLine 2\tTabbedEnd');
  });

  it('trims whitespace around bio', () => {
    expect(sanitizeBio('  Hello world  \n')).toBe('Hello world');
  });
});
