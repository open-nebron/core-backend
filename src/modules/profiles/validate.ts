import { env, getSupportedLanguages } from '../../config/env.js';
import { sanitizeBio, sanitizeName } from '../../utils/sanitizer.js';
import { isValidDobAtLeast13 } from './profile.schema.js';

export const HTML_TAG_REGEX = /<[^>]+>/;

export function containsNullByte(str: string): boolean {
  return str.includes('\u0000');
}

export function validateAbout(raw: string): string {
  if (containsNullByte(raw)) {
    throw new Error('Field contains null byte character (\\u0000)');
  }

  if (HTML_TAG_REGEX.test(raw)) {
    throw new Error('HTML tags are not allowed in about');
  }

  const newlineCount = (raw.match(/\n/g) || []).length;
  if (newlineCount > 100) {
    throw new Error('About must not exceed 100 newlines');
  }

  const sanitized = sanitizeBio(raw);

  if (sanitized.length > 2000) {
    throw new Error('About must not exceed 2000 characters');
  }

  return sanitized;
}

export function validateBio(raw: string): string {
  if (containsNullByte(raw)) {
    throw new Error('Field contains null byte character (\\u0000)');
  }

  if (HTML_TAG_REGEX.test(raw)) {
    throw new Error('HTML tags are not allowed in bio');
  }

  const sanitized = sanitizeBio(raw);

  if (sanitized.length > 300) {
    throw new Error('Bio must not exceed 300 characters');
  }

  return sanitized;
}

export function validateNameField(raw: string): string {
  if (containsNullByte(raw)) {
    throw new Error('Field contains null byte character (\\u0000)');
  }

  const sanitized = sanitizeName(raw);

  if (sanitized.length < 1 || sanitized.length > 80) {
    throw new Error('Name must be between 1 and 80 characters');
  }

  return sanitized;
}

export function validateLanguage(raw: string): string {
  if (containsNullByte(raw)) {
    throw new Error('Field contains null byte character (\\u0000)');
  }

  const normalized = raw.trim().toLowerCase();
  const supported = getSupportedLanguages();

  if (!supported.includes(normalized)) {
    throw new Error(`Unsupported language '${raw}'. Supported languages: ${supported.join(', ')}`);
  }

  return normalized;
}

export const ALLOWED_THEMES = ['light', 'dark', 'system'] as const;
export type UserThemeType = (typeof ALLOWED_THEMES)[number];

export function validateTheme(raw: string): UserThemeType {
  if (!ALLOWED_THEMES.includes(raw as any)) {
    throw new Error(`Invalid theme '${raw}'. Allowed values: ${ALLOWED_THEMES.join(', ')}`);
  }
  return raw as UserThemeType;
}

export function validateDob(dobStr: string): string {
  if (containsNullByte(dobStr)) {
    throw new Error('Field contains null byte character (\\u0000)');
  }

  if (!isValidDobAtLeast13(dobStr)) {
    throw new Error('Date of birth must be a valid date in YYYY-MM-DD format and you must be at least 13 years old');
  }

  return dobStr;
}
