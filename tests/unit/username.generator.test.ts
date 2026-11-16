import { describe, it, expect } from 'vitest';
import { generateUniqueUsername } from '../../src/modules/profiles/username.generator.js';
import { validateUsername } from '../../src/modules/profiles/username.rules.js';

describe('Username Generator', () => {
  it('generates username from email local-part', async () => {
    const existsFn = async () => false;
    const username = await generateUniqueUsername('john.doe@example.com', existsFn);
    expect(username).toBe('john.doe');
    expect(validateUsername(username).ok).toBe(true);
  });

  it('normalizes local-part with disallowed characters and repeat dots', async () => {
    const existsFn = async () => false;
    const username = await generateUniqueUsername('John..Doe+testing@example.com', existsFn);
    expect(username).toBe('john_doetesting');
    expect(validateUsername(username).ok).toBe(true);
  });

  it('handles local-parts starting with numbers by prefixing u_', async () => {
    const existsFn = async () => false;
    const username = await generateUniqueUsername('123456@example.com', existsFn);
    expect(username).toBe('u_123456');
    expect(validateUsername(username).ok).toBe(true);
  });

  it('falls back to user_<random> when email local-part is completely invalid or empty', async () => {
    const existsFn = async () => false;
    const username = await generateUniqueUsername('!!!@example.com', existsFn);
    expect(username.startsWith('user_')).toBe(true);
    expect(validateUsername(username).ok).toBe(true);
  });

  it('appends _2, _3 when base candidate is already taken', async () => {
    const taken = new Set(['johndoe', 'johndoe_2', 'johndoe_3']);
    const existsFn = async (u: string) => taken.has(u);

    const username = await generateUniqueUsername('johndoe@example.com', existsFn);
    expect(username).toBe('johndoe_4');
    expect(validateUsername(username).ok).toBe(true);
  });

  it('truncates base when appending suffix to stay within 20 char limit', async () => {
    // 20 chars base: abcdefghijklmnopqrst
    const longBase = 'abcdefghijklmnopqrst';
    const taken = new Set([longBase]);
    const existsFn = async (u: string) => taken.has(u);

    const username = await generateUniqueUsername(`${longBase}@example.com`, existsFn);
    expect(username.length).toBeLessThanOrEqual(20);
    expect(username.endsWith('_2')).toBe(true);
    expect(validateUsername(username).ok).toBe(true);
  });
});
