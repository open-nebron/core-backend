import { z } from 'zod';
import { isValidUserId } from '../relationships/validate.js';

const CONTROL_CHARS_ALLOW_LINEBREAKS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function sanitizePostBody(body: string): string {
  return body.replace(CONTROL_CHARS_ALLOW_LINEBREAKS, '').trim();
}

export const createPostSchema = z.object({
  body: z
    .string()
    .transform((val) => sanitizePostBody(val))
    .refine((val) => val.length >= 1, {
      message: 'Post body must not be empty',
    })
    .refine((val) => val.length <= 500, {
      message: 'Post body cannot exceed 500 characters',
    }),
  imageKey: z.string().nullable().optional(),
});

export const userIdParamSchema = z.object({
  userId: z.string().refine((val) => isValidUserId(val), {
    message: 'Invalid user ID format',
  }),
});

export const postIdParamSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid post ID format'),
});

export const followersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  before: z.string().datetime().optional(),
});

export const postsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().datetime().optional(),
});

export const suggestionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const likesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  before: z.string().datetime().optional(),
});

export const createCommentSchema = z.object({
  body: z
    .string()
    .transform((val) => sanitizePostBody(val))
    .refine((val) => val.length >= 1, {
      message: 'Comment body must not be empty',
    })
    .refine((val) => val.length <= 300, {
      message: 'Comment body cannot exceed 300 characters',
    }),
});

export const commentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  before: z.string().datetime().optional(),
});

export const commentIdParamSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid comment ID format'),
});

export const editPostSchema = z
  .object({
    body: z
      .string()
      .transform((val) => sanitizePostBody(val))
      .refine((val) => val.length >= 1, {
        message: 'Post body must not be empty',
      })
      .refine((val) => val.length <= 500, {
        message: 'Post body cannot exceed 500 characters',
      })
      .optional(),
    removeImage: z.boolean().optional(),
  })
  .refine((data) => data.body !== undefined || data.removeImage !== undefined, {
    message: 'At least one of body or removeImage must be provided',
  });

export const popularPostsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const userLikesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().datetime().optional(),
});
