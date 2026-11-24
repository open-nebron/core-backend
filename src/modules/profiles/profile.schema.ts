import { z } from 'zod';
import {
  validateAbout,
  validateBio,
  validateDob,
  validateLanguage,
  validateNameField,
} from './validate.js';
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
      .superRefine((val, ctx) => {
        try {
          validateNameField(val);
        } catch (err: any) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: err.message });
        }
      })
      .transform(sanitizeName)
      .optional(),
    dateOfBirth: z
      .string()
      .superRefine((val, ctx) => {
        try {
          validateDob(val);
        } catch (err: any) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: err.message });
        }
      })
      .optional(),
    about: z
      .string()
      .superRefine((val, ctx) => {
        try {
          validateAbout(val);
        } catch (err: any) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: err.message });
        }
      })
      .transform(sanitizeBio)
      .optional(),
    bio: z
      .string()
      .superRefine((val, ctx) => {
        try {
          validateBio(val);
        } catch (err: any) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: err.message });
        }
      })
      .transform(sanitizeBio)
      .optional(),
    language: z
      .string()
      .superRefine((val, ctx) => {
        try {
          validateLanguage(val);
        } catch (err: any) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: err.message });
        }
      })
      .transform((val) => val.trim().toLowerCase())
      .optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    messageRequestPolicy: z.enum(['everyone', 'known', 'nobody']).optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.name !== undefined ||
      data.dateOfBirth !== undefined ||
      data.about !== undefined ||
      data.bio !== undefined ||
      data.language !== undefined ||
      data.theme !== undefined ||
      data.messageRequestPolicy !== undefined,
    {
      message:
        'At least one field (name, dateOfBirth, about, bio, language, theme, messageRequestPolicy) must be provided',
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

export const uploadUrlSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  contentLength: z.number().int().positive('Content length must be a positive integer'),
});

export type UploadUrlInput = z.infer<typeof uploadUrlSchema>;

export const confirmUploadSchema = z.object({
  objectKey: z.string().min(1, 'objectKey is required'),
});

export type ConfirmUploadInput = z.infer<typeof confirmUploadSchema>;
