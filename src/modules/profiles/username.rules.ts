import { Filter } from 'bad-words';

export const RESERVED_USERNAMES = new Set([
  'admin',
  'root',
  'system',
  'support',
  'zenuxs',
  'api',
  'auth',
  'chat',
  'voice',
  'me',
  'null',
  'undefined',
  'help',
  'about',
  'settings',
  'login',
  'register',
]);

const filter = new Filter();

export interface UsernameValidationResult {
  ok: boolean;
  normalized: string;
  reason?: 'invalid_format' | 'reserved' | 'profane' | string;
}

/**
 * Validates a username according to Zenuxs core rules:
 * - 3–20 chars
 * - allowed: lowercase a-z, digits 0-9, underscore _, dot .
 * - must start with a letter
 * - must not end with _ or .
 * - no consecutive _._, __, ..
 * - reserved list (reject)
 * - case-insensitive uniqueness (store lowercase)
 * - profanity check using bad-words package
 */
export function validateUsername(raw: unknown): UsernameValidationResult {
  if (typeof raw !== 'string') {
    return { ok: false, normalized: '', reason: 'invalid_format' };
  }

  const normalized = raw.trim().toLowerCase();

  // 1. Reserved list check first (so words like 'me' return 'reserved' specifically)
  if (RESERVED_USERNAMES.has(normalized)) {
    return { ok: false, normalized, reason: 'reserved' };
  }

  // 2. Length check: 3–20 chars
  if (normalized.length < 3 || normalized.length > 20) {
    return { ok: false, normalized, reason: 'invalid_format' };
  }

  // 3. Allowed characters: lowercase a-z, 0-9, _, .
  if (!/^[a-z0-9_.]+$/.test(normalized)) {
    return { ok: false, normalized, reason: 'invalid_format' };
  }

  // 4. Must start with a letter
  if (!/^[a-z]/.test(normalized)) {
    return { ok: false, normalized, reason: 'invalid_format' };
  }

  // 5. Must not end with _ or .
  if (/[_]$/.test(normalized) || /[.]$/.test(normalized)) {
    return { ok: false, normalized, reason: 'invalid_format' };
  }

  // 6. No consecutive punctuation: __, .., ._, _., _._
  if (/[._]{2,}/.test(normalized)) {
    return { ok: false, normalized, reason: 'invalid_format' };
  }

  // 7. Profanity check (direct and space-separated punctuation)
  try {
    if (filter.isProfane(normalized) || filter.isProfane(normalized.replace(/[._]/g, ' '))) {
      return { ok: false, normalized, reason: 'profane' };
    }
  } catch {
    // If filter throws unexpectedly, fall back safely
  }

  return { ok: true, normalized };
}
