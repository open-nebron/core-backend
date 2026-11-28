import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin } from '../../auth/hook.js';
import { adminAnalyticsRateLimiter } from '../../plugins/rate-limit.js';
import {
  adminAnalyticsGrowthQuerySchema,
  adminAnalyticsPeriodSchema,
} from './admin-analytics.schema.js';
import { defaultAdminAnalyticsService } from './admin-analytics.service.js';

/**
 * Registers platform-wide admin analytics endpoints under `/admin/analytics/*`.
 * All routes enforce `requireAdmin` and Redis rate limiting.
 */
export const adminAnalyticsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const preHandler = [requireAdmin, adminAnalyticsRateLimiter];

  app.get('/admin/analytics/overview', { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { period } = adminAnalyticsPeriodSchema.parse(request.query);
    const data = await defaultAdminAnalyticsService.getOverview(period);
    return reply.status(200).send(data);
  });

  app.get('/admin/analytics/users', { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { period } = adminAnalyticsPeriodSchema.parse(request.query);
    const data = await defaultAdminAnalyticsService.getUsersAnalytics(period);
    return reply.status(200).send(data);
  });

  app.get('/admin/analytics/content', { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { period } = adminAnalyticsPeriodSchema.parse(request.query);
    const data = await defaultAdminAnalyticsService.getContentAnalytics(period);
    return reply.status(200).send(data);
  });

  app.get('/admin/analytics/chat', { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { period } = adminAnalyticsPeriodSchema.parse(request.query);
    const data = await defaultAdminAnalyticsService.getChatAnalytics(period);
    return reply.status(200).send(data);
  });

  app.get('/admin/analytics/moderation', { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { period } = adminAnalyticsPeriodSchema.parse(request.query);
    const data = await defaultAdminAnalyticsService.getModerationAnalytics(period);
    return reply.status(200).send(data);
  });

  app.get('/admin/analytics/features', { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { period } = adminAnalyticsPeriodSchema.parse(request.query);
    const data = await defaultAdminAnalyticsService.getFeaturesAnalytics(period);
    return reply.status(200).send(data);
  });

  app.get('/admin/analytics/growth', { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { period } = adminAnalyticsGrowthQuerySchema.parse(request.query);
    const data = await defaultAdminAnalyticsService.getGrowthAnalytics(period);
    return reply.status(200).send(data);
  });

  app.get('/admin/analytics/live', { preHandler }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const data = await defaultAdminAnalyticsService.getLiveAnalytics();
    return reply.status(200).send(data);
  });
};
