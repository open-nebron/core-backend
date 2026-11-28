import { z } from 'zod';
import emojiRegex from 'emoji-regex';
import { isValidUserId } from '../relationships/validate.js';
import { BadRequestError } from '../../utils/errors.js';

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
  parentCommentId: z.string().nullable().optional(),
});

export const commentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().datetime().optional(),
  sort: z.enum(['top', 'new']).default('top'),
});

export const commentRepliesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
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

export const editCommentSchema = z.object({
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

export const pinCommentParamSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid post ID format'),
  commentId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid comment ID format'),
});

export const hashtagParamSchema = z.object({
  tag: z
    .string()
    .transform((val) => val.replace(/^#/, '').trim().toLowerCase())
    .refine((val) => /^[a-z0-9_]{1,50}$/.test(val), {
      message: 'Invalid hashtag format',
    }),
});

export const hashtagPostsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().datetime().optional(),
});

export const trendingHashtagsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const savedListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().datetime().optional(),
});

export const shareContentSchema = z.object({
  contentType: z.enum(['post', 'reel', 'comment']),
  contentId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid content ID format'),
});

export const commentReactionParamsSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid comment ID format'),
  emoji: z.string().min(1),
});

/**
 * Validates that a comment reaction parameter decodes to a single valid emoji within 1-8 UTF-8 codepoints.
 */
export function validateCommentEmoji(rawEmoji: string): string {
  let decoded = rawEmoji;
  try {
    decoded = decodeURIComponent(rawEmoji);
  } catch {
    throw new BadRequestError('Invalid emoji encoding', 'invalid_emoji');
  }
  const emoji = decoded.trim();
  if (!emoji) {
    throw new BadRequestError('Emoji is required', 'invalid_emoji');
  }

  const codepoints = Array.from(emoji);
  if (codepoints.length < 1 || codepoints.length > 8) {
    throw new BadRequestError('Emoji must be between 1 and 8 codepoints', 'invalid_emoji');
  }

  const matches = emoji.match(emojiRegex());
  if (!matches || matches.length !== 1 || matches[0] !== emoji) {
    throw new BadRequestError('Invalid emoji', 'invalid_emoji');
  }

  return emoji;
}
