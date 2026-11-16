import crypto from 'node:crypto';
import { validateUsername } from './username.rules.js';

function getRandomString(length: number = 6): string {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

function normalizeLocalPart(localPart: string): string {
  let cleaned = localPart
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '') // strip disallowed chars
    .replace(/[._]{2,}/g, '_')   // collapse consecutive dots/underscores
    .replace(/^[._]+/, '')       // strip leading dots/underscores
    .replace(/[._]+$/, '');      // strip trailing dots/underscores

  if (!cleaned) {
    return '';
  }

  // If it doesn't start with a letter, prefix with 'u_'
  if (!/^[a-z]/.test(cleaned)) {
    cleaned = `u_${cleaned}`.replace(/[._]{2,}/g, '_');
  }

  // Truncate to max 20 chars and ensure it doesn't end with dot/underscore
  cleaned = cleaned.slice(0, 20).replace(/[._]+$/, '');

  return cleaned;
}

/**
 * Auto-generates a unique username from an email address:
 * - Take email local-part (before @)
 * - Normalize: lowercase, strip disallowed chars, collapse repeats, truncate to 20
 * - If empty or invalid after normalization -> fall back to user_<shortRandom>
 * - If taken -> append _<n> with n = 2,3,4... up to 999, then random suffix
 * - Returns a guaranteed valid, available username
 */
export async function generateUniqueUsername(
  email: string,
  existsFn: (username: string) => Promise<boolean>
): Promise<string> {
  const localPart = email ? email.split('@')[0] : '';
  const normalized = normalizeLocalPart(localPart);

  let baseCandidate = normalized;
  const validation = validateUsername(baseCandidate);

  if (!validation.ok) {
    baseCandidate = `user_${getRandomString(6)}`;
  }

  // 1. Check if baseCandidate is available
  if (!(await existsFn(baseCandidate))) {
    return baseCandidate;
  }

  // 2. Try _<n> with n from 2 up to 999
  for (let n = 2; n <= 999; n++) {
    const suffix = `_${n}`;
    const maxBaseLen = 20 - suffix.length;
    const trimmedBase = baseCandidate.slice(0, maxBaseLen).replace(/[._]+$/, '');
    const candidate = `${trimmedBase}${suffix}`;

    if (validateUsername(candidate).ok && !(await existsFn(candidate))) {
      return candidate;
    }
  }

  // 3. Fallback: random suffix
  for (let attempts = 0; attempts < 50; attempts++) {
    const randomSuffix = `_${getRandomString(4)}`;
    const maxBaseLen = 20 - randomSuffix.length;
    const trimmedBase = baseCandidate.slice(0, maxBaseLen).replace(/[._]+$/, '');
    const candidate = `${trimmedBase}${randomSuffix}`;

    if (validateUsername(candidate).ok && !(await existsFn(candidate))) {
      return candidate;
    }
  }

  // Ultimate fallback to guarantee unique valid name
  return `user_${getRandomString(8)}`;
}
