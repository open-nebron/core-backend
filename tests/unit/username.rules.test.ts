import { describe, it, expect } from 'vitest';
import { validateUsername, RESERVED_USERNAMES } from '../../src/modules/profiles/username.rules.js';

describe('Username Validation Rules', () => {
  it('accepts valid usernames', () => {
    const validUsernames = ['alice', 'bob123', 'john_doe', 'jane.doe', 'neo_7', 'a.b_c'];
    for (const u of validUsernames) {
      const res = validateUsername(u);
      expect(res.ok).toBe(true);
      expect(res.normalized).toBe(u.toLowerCase());
      expect(res.reason).toBeUndefined();
    }
  });

  it('normalizes uppercase to lowercase', () => {
    const res = validateUsername('JohnDoe');
    expect(res.ok).toBe(true);
    expect(res.normalized).toBe('johndoe');
  });

  it('rejects usernames that are too short (< 3 chars)', () => {
    expect(validateUsername('ab').ok).toBe(false);
    expect(validateUsername('a').ok).toBe(false);
    expect(validateUsername('').ok).toBe(false);
    expect(validateUsername('ab').reason).toBe('invalid_format');
  });

  it('rejects usernames that are too long (> 20 chars)', () => {
    const longUsername = 'a'.repeat(21);
    const res = validateUsername(longUsername);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('invalid_format');
  });

  it('accepts usernames exactly 3 and 20 chars long', () => {
    expect(validateUsername('abc').ok).toBe(true);
    expect(validateUsername('a'.repeat(20)).ok).toBe(true);
  });

  it('rejects usernames containing disallowed characters', () => {
    const invalid = ['user@name', 'user#1', 'user$dollar', 'user name', 'user-name', 'user!'];
    for (const u of invalid) {
      const res = validateUsername(u);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('invalid_format');
    }
  });

  it('must start with a letter (cannot start with digit, dot, underscore)', () => {
    expect(validateUsername('1user').ok).toBe(false);
    expect(validateUsername('1user').reason).toBe('invalid_format');
    expect(validateUsername('_user').ok).toBe(false);
    expect(validateUsername('.user').ok).toBe(false);
  });

  it('must not end with _ or .', () => {
    expect(validateUsername('user_').ok).toBe(false);
    expect(validateUsername('user_').reason).toBe('invalid_format');
    expect(validateUsername('user.').ok).toBe(false);
    expect(validateUsername('user.').reason).toBe('invalid_format');
  });

  it('rejects consecutive punctuation (__ , .. , ._ , _. , _._)', () => {
    const consecutive = ['user__name', 'user..name', 'user._name', 'user_.name', 'u_._ser'];
    for (const u of consecutive) {
      const res = validateUsername(u);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('invalid_format');
    }
  });

  it('rejects all reserved usernames', () => {
    for (const reserved of RESERVED_USERNAMES) {
      const res = validateUsername(reserved);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('reserved');
    }
  });

  it('rejects reserved username even with mixed casing', () => {
    expect(validateUsername('ADMIN').ok).toBe(false);
    expect(validateUsername('ADMIN').reason).toBe('reserved');
    expect(validateUsername('ZeNuXs').ok).toBe(false);
    expect(validateUsername('ZeNuXs').reason).toBe('reserved');
  });

  it('rejects profane words using bad-words', () => {
    const res = validateUsername('shithead');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('profane');
  });
});
