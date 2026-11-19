import { z } from 'zod';
import {
  EmptyMuteError,
  InvalidUntilError,
  InvalidUuidError,
  SelfActionNotAllowedError,
} from '../../utils/errors.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;
const USR_PREFIX_REGEX = /^usr_[a-zA-Z0-9_-]{3,64}$/;

export function isValidUserId(id: string): boolean {
  if (typeof id !== 'string') return false;
  return UUID_REGEX.test(id) || OBJECT_ID_REGEX.test(id) || USR_PREFIX_REGEX.test(id);
}

export function validateTargetUserId(callerUserId: string, targetUserId: string): string {
  if (!targetUserId || !isValidUserId(targetUserId)) {
    throw new InvalidUuidError('Invalid user ID format');
  }
  if (callerUserId === targetUserId) {
    throw new SelfActionNotAllowedError('Self action is not allowed');
  }
  return targetUserId;
}

export const muteBodySchema = z
  .object({
    calls: z.boolean().optional(),
    messages: z.boolean().optional(),
    until: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

export interface MuteInput {
  calls?: boolean;
  messages?: boolean;
  until?: string | null;
}

export function validateMuteInput(data: unknown): MuteInput {
  if (data === null || typeof data !== 'object') {
    throw new EmptyMuteError('Mute body must be an object');
  }

  const raw = data as Record<string, unknown>;

  // Check until first if provided
  if (raw.until !== undefined && raw.until !== null) {
    if (typeof raw.until !== 'string') {
      throw new InvalidUntilError('Mute until must be an ISO date string');
    }
    const untilDate = new Date(raw.until);
    if (isNaN(untilDate.getTime())) {
      throw new InvalidUntilError('Invalid until datetime format');
    }
    if (untilDate.getTime() <= Date.now()) {
      throw new InvalidUntilError('Mute until date must be in the future');
    }
  }

  const parsed = muteBodySchema.safeParse(data);
  if (!parsed.success) {
    const hasUntilError = parsed.error.issues.some((i) => i.path.includes('until'));
    if (hasUntilError) {
      throw new InvalidUntilError('Invalid until datetime format');
    }
    throw new EmptyMuteError(parsed.error.message);
  }

  const body = parsed.data;
  const hasCalls = body.calls === true;
  const hasMessages = body.messages === true;
  const hasUntil = body.until !== undefined && body.until !== null;

  if (!hasCalls && !hasMessages && !hasUntil) {
    throw new EmptyMuteError('Mute body must specify calls: true, messages: true, or until in the future');
  }

  return body;
}
