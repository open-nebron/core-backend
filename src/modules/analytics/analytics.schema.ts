import { z } from 'zod';
import type { FollowSourceType } from '../../db/mongo.js';

export const analyticsPeriodSchema = z.enum(['7d', '30d', '90d']).default('30d');
export const analyticsContentTypeSchema = z.enum(['post', 'reel', 'story']);
export const analyticsSourceSchema = z.enum([
  'feed',
  'profile',
  'explore',
  'shared',
  'hashtag',
  'recommendations',
]);

export const compareAgainstSchema = z.enum(['7d_ago', '30d_ago', 'previous_post']).default('previous_post');

export const contentCompareQuerySchema = z.object({
  against: compareAgainstSchema,
});

export const hashtagAnalyticsQuerySchema = z.object({
  period: analyticsPeriodSchema,
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const bestTimeQuerySchema = z.object({
  contentType: analyticsContentTypeSchema.optional(),
  period: analyticsPeriodSchema,
});

export const crossCompareQuerySchema = z.object({
  contentType: analyticsContentTypeSchema,
  contentIds: z
    .string()
    .trim()
    .min(1)
    .transform((s) =>
      Array.from(
        new Set(
          s
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        )
      )
    )
    .refine((ids) => ids.length >= 1 && ids.length <= 5, {
      message: 'contentIds must contain 1 to 5 IDs',
    }),
});

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

export const impressionSchema = z.object({
  contentType: analyticsContentTypeSchema,
  contentId: z.string().regex(objectIdRegex, 'Invalid contentId format'),
  source: analyticsSourceSchema,
});

export const viewStartSchema = z.object({
  contentType: z.enum(['reel', 'story']),
  contentId: z.string().regex(objectIdRegex, 'Invalid contentId format'),
  source: z.string().trim().min(1).max(40).default('feed'),
  sessionId: z.string().trim().min(1).max(128).optional(),
  totalSeconds: z.coerce.number().min(0).max(3600).optional(),
  replayed: z.boolean().optional(),
});

export const viewHeartbeatSchema = z.object({
  viewId: z.string().regex(objectIdRegex, 'Invalid viewId format'),
  watchedSeconds: z.coerce.number().min(0).max(36000),
  currentPosition: z.coerce.number().min(0).max(36000).optional(),
  tapsForward: z.coerce.number().int().min(0).max(1000).optional(),
  tapsBack: z.coerce.number().int().min(0).max(1000).optional(),
});

export const viewEndSchema = z.object({
  viewId: z.string().regex(objectIdRegex, 'Invalid viewId format'),
  watchedSeconds: z.coerce.number().min(0).max(36000),
  completed: z.boolean(),
  tapsForward: z.coerce.number().int().min(0).max(1000).optional(),
  tapsBack: z.coerce.number().int().min(0).max(1000).optional(),
  exited: z.boolean().optional(),
  replayed: z.boolean().optional(),
});

export const profileVisitSchema = z.object({
  visitedUserId: z.string().trim().min(1).max(128),
});

export const analyticsPeriodQuerySchema = z.object({
  period: analyticsPeriodSchema,
});

export const analyticsListQuerySchema = z.object({
  period: analyticsPeriodSchema,
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().datetime().optional(),
});

export const contentDetailParamsSchema = z.object({
  contentType: analyticsContentTypeSchema,
  contentId: z.string().regex(objectIdRegex, 'Invalid contentId format'),
});

const VALID_FOLLOW_SOURCES = new Set<FollowSourceType>([
  'profile',
  'feed',
  'reel',
  'search',
  'suggestion',
  'other',
]);

/**
 * Normalizes the X-Follow-Source header into a tracked follow source enum value.
 */
export function parseFollowSource(raw: unknown): FollowSourceType {
  if (typeof raw !== 'string') return 'other';
  const normalized = raw.trim().toLowerCase() as FollowSourceType;
  return VALID_FOLLOW_SOURCES.has(normalized) ? normalized : 'other';
}
