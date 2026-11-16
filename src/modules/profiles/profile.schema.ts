import { z } from 'zod';
import { sanitizeBio, sanitizeName } from '../../utils/sanitizer.js';

export function isValidDobAtLeast13(dobStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dobStr)) {
    return false;
  }

  const [y, m, d] = dobStr.split('-').map(Number);
  const dob = new Date(Date.UTC(y, m - 1, d));

  // Check valid calendar date
  if (
    dob.getUTCFullYear() !== y ||
    dob.getUTCMonth() !== m - 1 ||
    dob.getUTCDate() !== d
  ) {
    return false;
  }

  const now = new Date();
  const currentUtcYear = now.getUTCFullYear();
  const currentUtcMonth = now.getUTCMonth();
  const currentUtcDate = now.getUTCDate();

  // Exactly 13 years ago today
  const minEligibleDob = new Date(Date.UTC(currentUtcYear - 13, currentUtcMonth, currentUtcDate));
  // Not older than 120 years
  const maxReasonableDob = new Date(Date.UTC(currentUtcYear - 120, currentUtcMonth, currentUtcDate));

  return dob <= minEligibleDob && dob >= maxReasonableDob;
}

export const patchMeSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Name must be at least 1 character')
      .max(80, 'Name cannot exceed 80 characters')
      .transform(sanitizeName)
      .optional(),
    dateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be in YYYY-MM-DD format')
      .refine(isValidDobAtLeast13, {
        message: 'You must be at least 13 years old to use Zenuxs',
      })
      .optional(),
    bio: z
      .string()
      .max(300, 'Bio cannot exceed 300 characters')
      .transform(sanitizeBio)
      .optional(),
  })
  .refine(
    (data) => data.name !== undefined || data.dateOfBirth !== undefined || data.bio !== undefined,
    {
      message: 'At least one field (name, dateOfBirth, bio) must be provided',
    }
  );

export type PatchMeInput = z.infer<typeof patchMeSchema>;

export const patchUsernameSchema = z.object({
  username: z.string().min(1, 'Username is required'),
});

export type PatchUsernameInput = z.infer<typeof patchUsernameSchema>;

export const checkUsernameQuerySchema = z.object({
  username: z.string().min(1, 'Username query parameter is required'),
});

export type CheckUsernameQuery = z.infer<typeof checkUsernameQuerySchema>;
