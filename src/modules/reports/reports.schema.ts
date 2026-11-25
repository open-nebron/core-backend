import { z } from 'zod';

export const reportReasons = [
  'spam',
  'harassment',
  'hate',
  'sexual',
  'violence',
  'self_harm',
  'impersonation',
  'other',
] as const;

export const reportTargetTypes = ['user', 'post', 'comment', 'message'] as const;

export const reportStatuses = ['pending', 'resolved', 'dismissed'] as const;

export const adminActions = [
  'dismiss',
  'delete_post',
  'delete_comment',
  'delete_message',
  'ban_user',
  'warn_user',
] as const;

export const createReportSchema = z.object({
  targetType: z.enum(reportTargetTypes),
  targetId: z.string().min(1, 'targetId is required'),
  reason: z.enum(reportReasons),
  details: z.string().max(1000).optional(),
});

export const resolveReportSchema = z.object({
  action: z.enum(adminActions),
  note: z.string().max(500).optional(),
});

export const banUserSchema = z.object({
  reason: z.string().min(1, 'Reason is required').max(500),
});

export const getReportsQuerySchema = z.object({
  status: z.enum(reportStatuses).optional(),
  targetType: z.enum(reportTargetTypes).optional(),
  limit: z.coerce.number().min(1).max(100).default(30),
  before: z.string().datetime().optional(),
});

export const getUsersQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(30),
  before: z.string().datetime().optional(),
});
