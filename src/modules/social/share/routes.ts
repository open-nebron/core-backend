import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { authenticateRequest } from '../../../auth/hook.js';
import { shareRateLimiter } from '../../../plugins/rate-limit.js';
import { capture } from '../../../lib/analytics.js';
import { shareContentSchema } from '../validate.js';
import { defaultShareService } from './service.js';

interface ShareBody {
  contentType: 'post' | 'reel' | 'comment';
  contentId: string;
}

/**
 * Registers share tracking endpoint returning canonical deep links.
 */
export const shareRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post<{ Body: ShareBody }>(
    '/share',
    {
      preHandler: [authenticateRequest, shareRateLimiter],
      schema: {
        description: 'Record a content share (deduplicated 24h per user/content) and return canonical URL',
        tags: ['Social - Shares'],
        body: {
          type: 'object',
          required: ['contentType', 'contentId'],
          properties: {
            contentType: { type: 'string', enum: ['post', 'reel', 'comment'] },
            contentId: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['url', 'shareCount'],
            properties: {
              url: { type: 'string' },
              shareCount: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: ShareBody }>, reply: FastifyReply) => {
      const parsedBody = shareContentSchema.parse(request.body);
      const viewerId = request.user.userId;
      const result = await defaultShareService.shareContent(
        viewerId,
        parsedBody.contentType,
        parsedBody.contentId
      );
      capture(viewerId, 'content_shared', {
        contentType: parsedBody.contentType,
        contentId: parsedBody.contentId,
      });
      return reply.status(200).send(result);
    }
  );
};
