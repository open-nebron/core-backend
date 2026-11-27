import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { authenticateRequest } from '../../auth/hook.js';
import { getPostsCollection, getProfilesCollection, getReelsCollection } from '../../db/mongo.js';
import { getBlockedUserIds } from '../social/block-filter.js';
import { defaultPostService } from '../social/posts/service.js';
import { defaultReelsService } from '../reels/reels.service.js';
import { defaultSocialSearchService } from './meili.service.js';

const socialSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  type: z.enum(['posts', 'reels']).default('posts'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const searchRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get(
    '/search/social',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Search public posts and reels via Meilisearch with block filtering',
        tags: ['Search'],
        querystring: {
          type: 'object',
          required: ['q'],
          properties: {
            q: { type: 'string', minLength: 1, maxLength: 100 },
            type: { type: 'string', enum: ['posts', 'reels'], default: 'posts' },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const viewerId = request.user.userId;
      const { q, type, limit } = socialSearchQuerySchema.parse(request.query);

      const [blockedIds, bannedProfiles] = await Promise.all([
        getBlockedUserIds(viewerId),
        getProfilesCollection()
          .find({ isBanned: true }, { projection: { userId: 1 } })
          .toArray(),
      ]);

      const excludeAuthorIds = new Set<string>(blockedIds);
      for (const b of bannedProfiles) {
        excludeAuthorIds.add(b.userId);
      }

      if (type === 'posts') {
        const ids = await defaultSocialSearchService.searchPostIds(q, excludeAuthorIds, limit);
        if (ids.length === 0) {
          return reply.status(200).send({ query: q, type, items: [] });
        }

        const oids = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
        const rawDocs = await getPostsCollection()
          .find({ _id: { $in: oids }, deleted: false })
          .toArray();
        const docMap = new Map(rawDocs.map((d) => [d._id.toString(), d]));
        const orderedDocs = ids.map((id) => docMap.get(id)).filter((d): d is NonNullable<typeof d> => Boolean(d));

        const items = await defaultPostService.formatPostsList(viewerId, orderedDocs, {
          excludeBanned: true,
        });
        return reply.status(200).send({ query: q, type, items });
      }

      const ids = await defaultSocialSearchService.searchReelIds(q, excludeAuthorIds, limit);
      if (ids.length === 0) {
        return reply.status(200).send({ query: q, type, items: [] });
      }

      const oids = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
      const rawReels = await getReelsCollection()
        .find({ _id: { $in: oids }, deleted: false })
        .toArray();
      const reelMap = new Map(rawReels.map((r) => [r._id.toString(), r]));
      const orderedReels = ids
        .map((id) => reelMap.get(id))
        .filter((r): r is NonNullable<typeof r> => Boolean(r));

      const items = await defaultReelsService.enrichReels(orderedReels, viewerId);
      return reply.status(200).send({ query: q, type, items });
    }
  );
};
