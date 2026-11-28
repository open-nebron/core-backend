import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { authenticateRequest } from '../../auth/hook.js';
import {
  analyticsAudienceActivityRateLimiter,
  analyticsAudienceGrowthRateLimiter,
  analyticsAudienceSourcesRateLimiter,
  analyticsBeaconRateLimiter,
  analyticsBestTimeRateLimiter,
  analyticsCompareRateLimiter,
  analyticsCrossCompareRateLimiter,
  analyticsCurveRateLimiter,
  analyticsDecayRateLimiter,
  analyticsDepthRateLimiter,
  analyticsHashtagsRateLimiter,
  analyticsSpeedRateLimiter,
  analyticsTrafficRateLimiter,
} from '../../plugins/rate-limit.js';
import { defaultEngagementDepthService } from './engagement-depth.js';
import { defaultAnalyticsInsightsService } from './insights.service.js';
import {
  analyticsListQuerySchema,
  analyticsPeriodQuerySchema,
  bestTimeQuerySchema,
  contentCompareQuerySchema,
  contentDetailParamsSchema,
  crossCompareQuerySchema,
  hashtagAnalyticsQuerySchema,
  impressionSchema,
  profileVisitSchema,
  viewEndSchema,
  viewHeartbeatSchema,
  viewStartSchema,
} from './analytics.schema.js';
import { defaultAnalyticsService } from './analytics.service.js';

/**
 * Registers analytics beacon ingestion endpoints and creator analytics query routes.
 */
export const analyticsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // === Beacon Endpoints (300/min per user) ===

  app.post(
    '/analytics/impression',
    {
      preHandler: [authenticateRequest, analyticsBeaconRateLimiter],
      schema: {
        description: 'Record content impression (deduped 24h per user/content)',
        tags: ['Analytics'],
        body: {
          type: 'object',
          required: ['contentType', 'contentId', 'source'],
          properties: {
            contentType: { type: 'string', enum: ['post', 'reel', 'story'] },
            contentId: { type: 'string' },
            source: {
              type: 'string',
              enum: ['feed', 'profile', 'explore', 'shared', 'hashtag', 'recommendations'],
            },
          },
        },
        response: {
          204: { type: 'null' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = impressionSchema.parse(request.body);
      await defaultAnalyticsService.recordImpression(request.user.userId, body);
      return reply.status(204).send();
    }
  );

  app.post(
    '/analytics/view-start',
    {
      preHandler: [authenticateRequest, analyticsBeaconRateLimiter],
      schema: {
        description: 'Start a watch-through view session for a reel or story',
        tags: ['Analytics'],
        body: {
          type: 'object',
          required: ['contentType', 'contentId'],
          properties: {
            contentType: { type: 'string', enum: ['reel', 'story'] },
            contentId: { type: 'string' },
            source: { type: 'string' },
            sessionId: { type: 'string' },
            totalSeconds: { type: 'number' },
            replayed: { type: 'boolean' },
          },
        },
        response: {
          201: {
            type: 'object',
            required: ['viewId'],
            properties: {
              viewId: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = viewStartSchema.parse(request.body);
      const res = await defaultAnalyticsService.startView(request.user.userId, body);
      return reply.status(201).send(res);
    }
  );

  app.post(
    '/analytics/view-heartbeat',
    {
      preHandler: [authenticateRequest, analyticsBeaconRateLimiter],
      schema: {
        description: 'Update watchedSeconds on an active view session',
        tags: ['Analytics'],
        body: {
          type: 'object',
          required: ['viewId', 'watchedSeconds'],
          properties: {
            viewId: { type: 'string' },
            watchedSeconds: { type: 'number' },
            currentPosition: { type: 'number' },
            tapsForward: { type: 'integer' },
            tapsBack: { type: 'integer' },
          },
        },
        response: {
          204: { type: 'null' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = viewHeartbeatSchema.parse(request.body);
      await defaultAnalyticsService.heartbeatView(request.user.userId, body);
      return reply.status(204).send();
    }
  );

  app.post(
    '/analytics/view-end',
    {
      preHandler: [authenticateRequest, analyticsBeaconRateLimiter],
      schema: {
        description: 'Finalize watch session with final watchedSeconds, completion, and taps/exits',
        tags: ['Analytics'],
        body: {
          type: 'object',
          required: ['viewId', 'watchedSeconds', 'completed'],
          properties: {
            viewId: { type: 'string' },
            watchedSeconds: { type: 'number' },
            completed: { type: 'boolean' },
            tapsForward: { type: 'integer' },
            tapsBack: { type: 'integer' },
            exited: { type: 'boolean' },
            replayed: { type: 'boolean' },
          },
        },
        response: {
          204: { type: 'null' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = viewEndSchema.parse(request.body);
      await defaultAnalyticsService.endView(request.user.userId, body);
      return reply.status(204).send();
    }
  );

  app.post(
    '/analytics/profile-visit',
    {
      preHandler: [authenticateRequest, analyticsBeaconRateLimiter],
      schema: {
        description: 'Record a profile visit (deduped 6h per visitor/target)',
        tags: ['Analytics'],
        body: {
          type: 'object',
          required: ['visitedUserId'],
          properties: {
            visitedUserId: { type: 'string' },
          },
        },
        response: {
          204: { type: 'null' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = profileVisitSchema.parse(request.body);
      await defaultAnalyticsService.recordProfileVisit(request.user.userId, body.visitedUserId);
      return reply.status(204).send();
    }
  );

  // === Creator Analytics Query Endpoints (Strictly scoped to authenticated user) ===

  app.get(
    '/analytics/me/overview',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get creator analytics overview for 7d|30d|90d',
        tags: ['Analytics'],
        querystring: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['7d', '30d', '90d'], default: '30d' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { period } = analyticsPeriodQuerySchema.parse(request.query);
      const data = await defaultAnalyticsService.getOverview(request.user.userId, period);
      return reply.status(200).send(data);
    }
  );

  app.get(
    '/analytics/me/posts',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get per-post analytics sorted by createdAt DESC',
        tags: ['Analytics'],
        querystring: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['7d', '30d', '90d'], default: '30d' },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            before: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { period, limit, before } = analyticsListQuerySchema.parse(request.query);
      const data = await defaultAnalyticsService.getPostsAnalytics(
        request.user.userId,
        period,
        limit,
        before
      );
      return reply.status(200).send(data);
    }
  );

  app.get(
    '/analytics/me/reels',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get per-reel analytics with watch duration and completion rate',
        tags: ['Analytics'],
        querystring: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['7d', '30d', '90d'], default: '30d' },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            before: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { period, limit, before } = analyticsListQuerySchema.parse(request.query);
      const data = await defaultAnalyticsService.getReelsAnalytics(
        request.user.userId,
        period,
        limit,
        before
      );
      return reply.status(200).send(data);
    }
  );

  app.get(
    '/analytics/me/stories',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get per-story analytics including tapsForward, tapsBack, and exits',
        tags: ['Analytics'],
        querystring: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['7d', '30d', '90d'], default: '30d' },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            before: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { period, limit, before } = analyticsListQuerySchema.parse(request.query);
      const data = await defaultAnalyticsService.getStoriesAnalytics(
        request.user.userId,
        period,
        limit,
        before
      );
      return reply.status(200).send(data);
    }
  );

  app.get(
    '/analytics/me/content/:contentType/:contentId',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get daily time series analytics for a single owned content item',
        tags: ['Analytics'],
        params: {
          type: 'object',
          required: ['contentType', 'contentId'],
          properties: {
            contentType: { type: 'string', enum: ['post', 'reel', 'story'] },
            contentId: { type: 'string' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['7d', '30d', '90d'], default: '30d' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { contentType, contentId } = contentDetailParamsSchema.parse(request.params);
      const { period } = analyticsPeriodQuerySchema.parse(request.query);
      const data = await defaultAnalyticsService.getContentDeepDive(
        request.user.userId,
        contentType,
        contentId,
        period
      );
      return reply.status(200).send(data);
    }
  );

  app.get(
    '/analytics/me/content/:contentType/:contentId/depth',
    {
      preHandler: [authenticateRequest, analyticsDepthRateLimiter],
      schema: {
        description: 'Get engagement depth metrics and top commenters for a single owned content item',
        tags: ['Analytics'],
        params: {
          type: 'object',
          required: ['contentType', 'contentId'],
          properties: {
            contentType: { type: 'string', enum: ['post', 'reel', 'story'] },
            contentId: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { contentType, contentId } = contentDetailParamsSchema.parse(request.params);
      const data = await defaultEngagementDepthService.getContentDepth(
        request.user.userId,
        contentType,
        contentId
      );
      return reply.status(200).send(data);
    }
  );

  app.get(
    '/analytics/me/audience',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get aggregated follower growth and active hours (no PII exposed)',
        tags: ['Analytics'],
        querystring: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['7d', '30d', '90d'], default: '30d' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { period } = analyticsPeriodQuerySchema.parse(request.query);
      const data = await defaultAnalyticsService.getAudienceAnalytics(request.user.userId, period);
      return reply.status(200).send(data);
    }
  );

  // === V4.5-2 Enhanced Per-Content, Hashtag, Timing & Audience Insights ===

  app.get(
    '/analytics/me/content/:contentType/:contentId/curve',
    {
      preHandler: [authenticateRequest, analyticsCurveRateLimiter],
      schema: {
        description: 'Get 10% retention drop-off curve (reels/stories) or 7d hourly engagement curve (posts)',
        tags: ['Analytics'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { contentType, contentId } = contentDetailParamsSchema.parse(request.params);
      const data = await defaultAnalyticsInsightsService.getContentCurve(
        request.user.userId,
        contentType,
        contentId
      );
      return reply.status(200).send(data);
    }
  );

  app.get(
    '/analytics/me/content/:contentType/:contentId/traffic',
    {
      preHandler: [authenticateRequest, analyticsTrafficRateLimiter],
      schema: {
        description: 'Get traffic source attribution (impressions + attributed engagements)',
        tags: ['Analytics'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { contentType, contentId } = contentDetailParamsSchema.parse(request.params);
      const data = await defaultAnalyticsInsightsService.getContentTraffic(
        request.user.userId,
        contentType,
        contentId
      );
      return reply.status(200).send(data);
    }
  );

  app.get(
    '/analytics/me/content/:contentType/:contentId/compare',
    {
      preHandler: [authenticateRequest, analyticsCompareRateLimiter],
      schema: {
        description: 'Compare content against previous_post, 7d_ago, or 30d_ago',
        tags: ['Analytics'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { contentType, contentId } = contentDetailParamsSchema.parse(request.params);
      const { against } = contentCompareQuerySchema.parse(request.query);
      const data = await defaultAnalyticsInsightsService.getCohortComparison(
        request.user.userId,
        contentType,
        contentId,
        against
      );
      return reply.status(200).send(data);
    }
  );

  app.get(
    '/analytics/me/content/:contentType/:contentId/speed',
    {
      preHandler: [authenticateRequest, analyticsSpeedRateLimiter],
      schema: {
        description: 'Get time-to-first-engagement and half-engagement speed rating',
        tags: ['Analytics'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { contentType, contentId } = contentDetailParamsSchema.parse(request.params);
      const data = await defaultAnalyticsInsightsService.getContentSpeed(
        request.user.userId,
        contentType,
        contentId
      );
      return reply.status(200).send(data);
    }
  );

  app.get(
    '/analytics/me/content/:contentType/:contentId/decay',
    {
      preHandler: [authenticateRequest, analyticsDecayRateLimiter],
      schema: {
        description: 'Get content engagement decay curve by age bucket',
        tags: ['Analytics'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { contentType, contentId } = contentDetailParamsSchema.parse(request.params);
      const data = await defaultAnalyticsInsightsService.getContentDecay(
        request.user.userId,
        contentType,
        contentId
      );
      return reply.status(200).send(data);
    }
  );

  app.get(
    '/analytics/me/hashtags',
    {
      preHandler: [authenticateRequest, analyticsHashtagsRateLimiter],
      schema: {
        description: 'Get hashtag performance relative to creator baseline',
        tags: ['Analytics'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { period, limit } = hashtagAnalyticsQuerySchema.parse(request.query);
      const data = await defaultAnalyticsInsightsService.getHashtagAnalytics(
        request.user.userId,
        period,
        limit
      );
      return reply.status(200).send(data);
    }
  );

  app.get(
    '/analytics/me/best-time',
    {
      preHandler: [authenticateRequest, analyticsBestTimeRateLimiter],
      schema: {
        description: 'Get content-type-aware best time to post recommendations',
        tags: ['Analytics'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { contentType, period } = bestTimeQuerySchema.parse(request.query);
      const data = await defaultAnalyticsInsightsService.getBestTime(
        request.user.userId,
        contentType,
        period
      );
      return reply.status(200).send(data);
    }
  );

  app.get(
    '/analytics/me/audience/activity',
    {
      preHandler: [authenticateRequest, analyticsAudienceActivityRateLimiter],
      schema: {
        description: 'Get follower activity patterns by hour and day of week',
        tags: ['Analytics'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { period } = analyticsPeriodQuerySchema.parse(request.query);
      const data = await defaultAnalyticsInsightsService.getAudienceActivity(
        request.user.userId,
        period
      );
      return reply.status(200).send(data);
    }
  );

  app.get(
    '/analytics/me/audience/growth',
    {
      preHandler: [authenticateRequest, analyticsAudienceGrowthRateLimiter],
      schema: {
        description: 'Get daily/weekly/monthly follower growth, churn, and 30d retention',
        tags: ['Analytics'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { period } = analyticsPeriodQuerySchema.parse(request.query);
      const data = await defaultAnalyticsInsightsService.getAudienceGrowth(
        request.user.userId,
        period
      );
      return reply.status(200).send(data);
    }
  );

  app.get(
    '/analytics/me/audience/sources',
    {
      preHandler: [authenticateRequest, analyticsAudienceSourcesRateLimiter],
      schema: {
        description: 'Get follower growth attribution sources and stacked daily trend',
        tags: ['Analytics'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { period } = analyticsPeriodQuerySchema.parse(request.query);
      const data = await defaultAnalyticsInsightsService.getAudienceSources(
        request.user.userId,
        period
      );
      return reply.status(200).send(data);
    }
  );

  app.get(
    '/analytics/me/compare',
    {
      preHandler: [authenticateRequest, analyticsCrossCompareRateLimiter],
      schema: {
        description: 'Side-by-side comparison of up to 5 content items of the same type',
        tags: ['Analytics'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { contentType, contentIds } = crossCompareQuerySchema.parse(request.query);
      const data = await defaultAnalyticsInsightsService.getCrossContentCompare(
        request.user.userId,
        contentType,
        contentIds
      );
      return reply.status(200).send(data);
    }
  );
};
