import { z } from 'zod';
import { sanitizePostBody } from '../social/validate.js';
import { isValidUserId } from '../relationships/validate.js';

export const storyUploadUrlSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'video/mp4']),
  contentLength: z.coerce.number().int().positive(),
});

export type StoryUploadUrlInput = z.infer<typeof storyUploadUrlSchema>;

export const storyConfirmSchema = z.object({
  objectKey: z.string().min(1),
  mediaType: z.enum(['image', 'video']),
  duration: z.coerce.number().int().min(1).max(15).optional(),
  caption: z
    .string()
    .transform((val) => sanitizePostBody(val))
    .refine((val) => val.length <= 200, {
      message: 'Caption cannot exceed 200 characters',
    })
    .nullable()
    .optional(),
  thumbnailKey: z.string().nullable().optional(),
});

export type StoryConfirmInput = z.infer<typeof storyConfirmSchema>;

export const storyIdParamSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid story ID format'),
});

export const storyUserIdParamSchema = z.object({
  userId: z.string().refine((val) => isValidUserId(val), {
    message: 'Invalid user ID format',
  }),
});
