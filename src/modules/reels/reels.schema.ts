import { z } from 'zod';
import { env } from '../../config/env.js';
import { sanitizePostBody } from '../social/validate.js';
import { isValidUserId } from '../relationships/validate.js';

export const reelIdParamSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid reel ID format'),
});

export const reelUserIdParamSchema = z.object({
  userId: z.string().refine((val) => isValidUserId(val), {
    message: 'Invalid user ID format',
  }),
});

export const reelUploadUrlSchema = z.object({
  contentType: z.enum(['video/mp4']),
  contentLength: z
    .number()
    .int()
    .min(1, 'File must not be empty')
    .max(env.MAX_REEL_VIDEO_BYTES, `Reel video cannot exceed ${env.MAX_REEL_VIDEO_BYTES} bytes`),
});

export const reelThumbnailUploadUrlSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  contentLength: z
    .number()
    .int()
    .min(1, 'File must not be empty')
    .max(env.MAX_REEL_THUMBNAIL_BYTES, `Thumbnail cannot exceed ${env.MAX_REEL_THUMBNAIL_BYTES} bytes`),
});

export const reelConfirmSchema = z.object({
  videoKey: z.string().min(1, 'videoKey is required'),
  thumbnailKey: z.string().min(1).nullable().optional(),
  caption: z
    .string()
    .transform((val) => sanitizePostBody(val))
    .refine((val) => val.length <= 300, {
      message: 'Caption cannot exceed 300 characters',
    })
    .nullable()
    .optional(),
  duration: z
    .number()
    .finite('Duration must be a valid number')
    .min(5, 'Reel duration must be at least 5 seconds')
    .max(60, 'Reel duration cannot exceed 60 seconds'),
});

export const reelsFeedQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

export const reelLikesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  before: z.string().datetime().optional(),
});

export const reelCommentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  before: z.string().datetime().optional(),
});

export type ReelConfirmInput = z.infer<typeof reelConfirmSchema>;
