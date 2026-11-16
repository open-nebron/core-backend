import { describe, it, expect } from 'vitest';
import {
  validateAbout,
  validateBio,
  validateLanguage,
  validateTheme,
  containsNullByte,
} from '../../src/modules/profiles/validate.js';
import { generateObjectKey, isValidUserKey } from '../../src/lib/r2.js';

describe('Media and Preferences Validation', () => {
  describe('Null byte detection', () => {
    it('detects null bytes in strings', () => {
      expect(containsNullByte('hello\u0000world')).toBe(true);
      expect(containsNullByte('clean string')).toBe(false);
    });

    it('rejects fields containing null byte', () => {
      expect(() => validateAbout('test\u0000bio')).toThrow('null byte');
      expect(() => validateBio('test\u0000tagline')).toThrow('null byte');
      expect(() => validateLanguage('en\u0000')).toThrow('null byte');
    });
  });

  describe('About and Bio validation', () => {
    it('rejects about containing HTML tags', () => {
      expect(() => validateAbout('Hello <script>alert(1)</script>')).toThrow('HTML tags are not allowed');
      expect(() => validateAbout('<b>Bold</b> text')).toThrow('HTML tags are not allowed');
      expect(() => validateAbout('Click <a href="x">here</a>')).toThrow('HTML tags are not allowed');
    });

    it('rejects bio containing HTML tags', () => {
      expect(() => validateBio('Engineer <i>specialist</i>')).toThrow('HTML tags are not allowed');
    });

    it('rejects about exceeding 2000 characters', () => {
      const longAbout = 'a'.repeat(2001);
      expect(() => validateAbout(longAbout)).toThrow('must not exceed 2000 characters');
    });

    it('accepts about with exactly 2000 characters', () => {
      const exactAbout = 'a'.repeat(2000);
      expect(validateAbout(exactAbout)).toBe(exactAbout);
    });

    it('rejects about exceeding 100 newlines', () => {
      const tooManyNewlines = 'line\n'.repeat(101);
      expect(() => validateAbout(tooManyNewlines)).toThrow('must not exceed 100 newlines');
    });

    it('accepts valid about with allowed newlines', () => {
      const validAbout = 'Line 1\nLine 2\nLine 3';
      expect(validateAbout(validAbout)).toBe(validAbout);
    });

    it('rejects bio exceeding 300 characters', () => {
      const longBio = 'b'.repeat(301);
      expect(() => validateBio(longBio)).toThrow('must not exceed 300 characters');
    });

    it('accepts valid bio with up to 300 characters', () => {
      const validBio = 'Clean tagline for my profile.';
      expect(validateBio(validBio)).toBe(validBio);
    });
  });

  describe('Language validation', () => {
    it('accepts supported language codes in lowercase', () => {
      expect(validateLanguage('en')).toBe('en');
      expect(validateLanguage('hi')).toBe('hi');
      expect(validateLanguage('ta')).toBe('ta');
    });

    it('normalizes uppercase language codes to lowercase', () => {
      expect(validateLanguage('EN')).toBe('en');
      expect(validateLanguage('HI')).toBe('hi');
    });

    it('rejects unsupported language codes', () => {
      expect(() => validateLanguage('xx')).toThrow('Unsupported language');
      expect(() => validateLanguage('klingon')).toThrow('Unsupported language');
    });
  });

  describe('Theme validation', () => {
    it('accepts light, dark, and system themes', () => {
      expect(validateTheme('light')).toBe('light');
      expect(validateTheme('dark')).toBe('dark');
      expect(validateTheme('system')).toBe('system');
    });

    it('rejects invalid themes', () => {
      expect(() => validateTheme('neon')).toThrow('Invalid theme');
      expect(() => validateTheme('blue')).toThrow('Invalid theme');
    });
  });

  describe('R2 Object Key rules', () => {
    it('generates keys under users/{userId}/avatar/ with correct extension', () => {
      const key = generateObjectKey('usr_123', 'avatar', 'image/png');
      expect(key.startsWith('users/usr_123/avatar/')).toBe(true);
      expect(key.endsWith('.png')).toBe(true);
    });

    it('generates keys under users/{userId}/banner/ with correct extension', () => {
      const key = generateObjectKey('usr_123', 'banner', 'image/jpeg');
      expect(key.startsWith('users/usr_123/banner/')).toBe(true);
      expect(key.endsWith('.jpg')).toBe(true);
    });

    it('validates user ownership of object key', () => {
      expect(isValidUserKey('usr_123', 'avatar', 'users/usr_123/avatar/abc-123.jpg')).toBe(true);
      expect(isValidUserKey('usr_123', 'avatar', 'users/other_user/avatar/abc-123.jpg')).toBe(false);
      expect(isValidUserKey('usr_123', 'avatar', 'users/usr_123/banner/abc-123.jpg')).toBe(false);
      expect(isValidUserKey('usr_123', 'avatar', 'random/path/abc-123.jpg')).toBe(false);
    });
  });
});
