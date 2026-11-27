import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { authenticateRequest } from '../../auth/hook.js';
import { userSearchRateLimiter, userGetRateLimiter } from '../../plugins/rate-limit.js';
import { getProfilesCollection, getFollowsCollection, type ProfileDocument, DEFAULT_PRIVACY } from '../../db/mongo.js';
import { NotFoundError, BlockedError } from '../../utils/errors.js';
import { computePublicUrl } from '../../lib/r2.js';
import { env } from '../../config/env.js';
import { getBlockedUserIds, isBlockedPair } from '../social/block-filter.js';

interface SearchUsersQuery {
  q?: string;
  limit?: string | number;
}

interface ByUsernameParams {
  username: string;
}

interface ByUserIdParams {
  userId: string;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function authenticateUserOrInternal(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const incoming = request.headers['x-internal-token'];
  if (incoming && incoming === env.INTERNAL_TOKEN) {
    return;
  }
  return authenticateRequest(request, reply);
}

export const userRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // 1. GET /users/search?q=<string>&limit=20
  app.get<{ Querystring: SearchUsersQuery }>(
    '/users/search',
    {
      preHandler: [authenticateRequest, userSearchRateLimiter],
      schema: {
        description: 'Search users by username or display name prefix',
        tags: ['Users'],
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', minLength: 1, maxLength: 50 },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
          required: ['q'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              users: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    userId: { type: 'string' },
                    username: { type: 'string' },
                    name: { type: 'string', nullable: true },
                    avatarUrl: { type: 'string', nullable: true },
                    followerCount: { type: 'integer' },
                    isFollowingViewer: { type: 'boolean' },
                    isFollowedByViewer: { type: 'boolean' },
                  },
                  required: ['userId', 'username'],
                },
              },
            },
            required: ['users'],
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: SearchUsersQuery }>, reply: FastifyReply) => {
      const rawQ = request.query.q || '';
      const trimmed = rawQ.trim().toLowerCase();

      if (!trimmed || trimmed.length === 0) {
        return reply.status(200).send({ users: [] });
      }

      const rawLimit = Number(request.query.limit);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 20;

      const escaped = escapeRegex(trimmed);
      const regex = new RegExp(escaped, 'i');

      const collection = getProfilesCollection();
      const docs = await collection
        .find({
          $or: [
            { username: { $regex: regex } },
            { name: { $regex: regex } },
          ],
        })
        .limit(limit * 2)
        .toArray();

      // Rank prefix matches above mid-string matches
      docs.sort((a: ProfileDocument, b: ProfileDocument) => {
        const aPrefix =
          a.username.toLowerCase().startsWith(trimmed) ||
          Boolean(a.name && a.name.toLowerCase().startsWith(trimmed));
        const bPrefix =
          b.username.toLowerCase().startsWith(trimmed) ||
          Boolean(b.name && b.name.toLowerCase().startsWith(trimmed));
        if (aPrefix === bPrefix) return 0;
        return aPrefix ? -1 : 1;
      });

      const viewerId = request.user?.userId;
      let candidateDocs = docs;

      if (viewerId) {
        const candidateIds = docs.map((d) => d.userId);
        const blockedIds = await getBlockedUserIds(viewerId, candidateIds);
        candidateDocs = docs.filter((d) => !blockedIds.has(d.userId));
      }

      const selectedDocs = candidateDocs.slice(0, limit);
      const selectedUserIds = selectedDocs.map((d) => d.userId);

      let followingViewerSet = new Set<string>();
      let followedByViewerSet = new Set<string>();
      if (viewerId && selectedUserIds.length > 0) {
        const [followersDocs, followingDocs] = await Promise.all([
          getFollowsCollection()
            .find({ followerId: { $in: selectedUserIds }, followingId: viewerId })
            .toArray(),
          getFollowsCollection()
            .find({ followerId: viewerId, followingId: { $in: selectedUserIds } })
            .toArray(),
        ]);
        followingViewerSet = new Set(followersDocs.map((d) => d.followerId));
        followedByViewerSet = new Set(followingDocs.map((d) => d.followingId));
      }

      const users = selectedDocs.map((doc: ProfileDocument) => ({
        userId: doc.userId,
        username: doc.username,
        name: doc.name ?? null,
        avatarUrl: computePublicUrl(doc.avatarKey, doc.updatedAt),
        followerCount: doc.followerCount ?? 0,
        isFollowingViewer: followingViewerSet.has(doc.userId),
        isFollowedByViewer: followedByViewerSet.has(doc.userId),
      }));

      return reply.status(200).send({ users });
    }
  );

  // 2. GET /users/by-username/:username
  app.get<{ Params: ByUsernameParams }>(
    '/users/by-username/:username',
    {
      preHandler: [authenticateRequest, userGetRateLimiter],
      schema: {
        description: 'Fetch user public profile summary by username',
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            username: { type: 'string' },
          },
          required: ['username'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              userId: { type: 'string' },
              username: { type: 'string' },
              name: { type: 'string', nullable: true },
              avatarUrl: { type: 'string', nullable: true },
              bannerUrl: { type: 'string', nullable: true },
              bio: { type: 'string', nullable: true },
              about: { type: 'string', nullable: true },
              followerCount: { type: 'integer' },
              followingCount: { type: 'integer' },
              postCount: { type: 'integer' },
              isFollowingViewer: { type: 'boolean' },
              isFollowedByViewer: { type: 'boolean' },
              createdAt: { type: 'string' },
            },
            required: ['userId', 'username', 'createdAt'],
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: ByUsernameParams }>, reply: FastifyReply) => {
      const username = (request.params.username || '').trim().toLowerCase();
      const collection = getProfilesCollection();
      const doc = await collection.findOne({ username });

      if (!doc) {
        throw new NotFoundError(`User with username '${username}' not found`);
      }

      const viewerId = request.user?.userId;
      let isFollowingViewer = false;
      let isFollowedByViewer = false;

      if (viewerId) {
        const isBlocked = await isBlockedPair(viewerId, doc.userId);
        if (isBlocked) {
          throw new BlockedError();
        }

        if (viewerId !== doc.userId) {
          const [f1, f2] = await Promise.all([
            getFollowsCollection().findOne({ followerId: doc.userId, followingId: viewerId }),
            getFollowsCollection().findOne({ followerId: viewerId, followingId: doc.userId }),
          ]);
          isFollowingViewer = !!f1;
          isFollowedByViewer = !!f2;
        }
      }

      return reply.status(200).send({
        userId: doc.userId,
        username: doc.username,
        name: doc.name ?? null,
        avatarUrl: computePublicUrl(doc.avatarKey, doc.updatedAt),
        bannerUrl: computePublicUrl(doc.bannerKey, doc.updatedAt),
        bio: doc.bio ?? null,
        about: doc.about ?? null,
        followerCount: doc.followerCount ?? 0,
        followingCount: doc.followingCount ?? 0,
        postCount: doc.postCount ?? 0,
        isFollowingViewer,
        isFollowedByViewer,
        createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : new Date(doc.createdAt).toISOString(),
      });
    }
  );

  // 3. GET /users/:userId
  app.get<{ Params: ByUserIdParams }>(
    '/users/:userId',
    {
      preHandler: [authenticateUserOrInternal, userGetRateLimiter],
      schema: {
        description: 'Fetch public profile by userId',
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            userId: { type: 'string' },
          },
          required: ['userId'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              userId: { type: 'string' },
              username: { type: 'string' },
              name: { type: 'string', nullable: true },
              avatarUrl: { type: 'string', nullable: true },
              bannerUrl: { type: 'string', nullable: true },
              bio: { type: 'string', nullable: true },
              about: { type: 'string', nullable: true },
              messageRequestPolicy: { type: 'string', enum: ['everyone', 'known', 'nobody'] },
              followerCount: { type: 'integer' },
              followingCount: { type: 'integer' },
              postCount: { type: 'integer' },
              isFollowingViewer: { type: 'boolean' },
              isFollowedByViewer: { type: 'boolean' },
              online: { type: 'boolean' },
              lastSeenAt: { type: 'string', nullable: true },
              privacy: {
                type: 'object',
                properties: {
                  showOnlineStatus: { type: 'string', enum: ['everyone', 'contacts', 'nobody'] },
                  showLastSeen: { type: 'string', enum: ['everyone', 'contacts', 'nobody'] },
                  sendReadReceipts: { type: 'boolean' },
                },
              },
              createdAt: { type: 'string' },
            },
            required: ['userId', 'username', 'createdAt'],
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: ByUserIdParams }>, reply: FastifyReply) => {
      const userId = (request.params.userId || '').trim();
      const collection = getProfilesCollection();
      const doc = await collection.findOne({ userId });

      if (!doc) {
        throw new NotFoundError(`User with ID '${userId}' not found`);
      }

      const isSelf = Boolean(request.user?.userId && request.user.userId === doc.userId);
      const isInternal = Boolean(
        request.headers['x-internal-token'] && request.headers['x-internal-token'] === env.INTERNAL_TOKEN
      );

      const privacy = doc.privacy || DEFAULT_PRIVACY;

      // Privacy checks for online status:
      // if viewer sees showOnlineStatus = 'nobody' -> don't include online
      // (contacts rule deferred — needs follow system; treat 'contacts' as 'everyone' for now)
      // TODO: When follow/contacts system is implemented, check if viewer is in user's contacts for 'contacts' rule
      let includeOnline = isSelf || isInternal;
      if (!includeOnline) {
        if (privacy.showOnlineStatus === 'everyone' || privacy.showOnlineStatus === 'contacts') {
          includeOnline = true;
        }
      }

      // Privacy checks for last seen:
      // if viewer sees showLastSeen = 'nobody' -> don't include lastSeenAt
      // (contacts rule deferred — needs follow system; treat 'contacts' as 'everyone' for now)
      // TODO: When follow/contacts system is implemented, check if viewer is in user's contacts for 'contacts' rule
      let includeLastSeen = isSelf || isInternal;
      if (!includeLastSeen) {
        if (privacy.showLastSeen === 'everyone' || privacy.showLastSeen === 'contacts') {
          includeLastSeen = true;
        }
      }

      const responseObj: Record<string, unknown> = {
        userId: doc.userId,
        username: doc.username,
        name: doc.name ?? null,
        avatarUrl: computePublicUrl(doc.avatarKey, doc.updatedAt),
        bannerUrl: computePublicUrl(doc.bannerKey, doc.updatedAt),
        bio: doc.bio ?? null,
        about: doc.about ?? null,
        messageRequestPolicy: doc.messageRequestPolicy || 'known',
        createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : new Date(doc.createdAt).toISOString(),
      };

      if (isSelf || isInternal) {
        responseObj.privacy = privacy;
      }

      if (includeOnline && doc.online !== undefined) {
        responseObj.online = doc.online;
      }

      if (includeLastSeen && doc.lastSeenAt !== undefined) {
        responseObj.lastSeenAt =
          doc.lastSeenAt === null
            ? null
            : doc.lastSeenAt instanceof Date
            ? doc.lastSeenAt.toISOString()
            : new Date(doc.lastSeenAt).toISOString();
      }

      let isFollowingViewer = false;
      let isFollowedByViewer = false;
      const viewerId = request.user?.userId;
      if (viewerId && viewerId !== doc.userId) {
        const [f1, f2] = await Promise.all([
          getFollowsCollection().findOne({ followerId: doc.userId, followingId: viewerId }),
          getFollowsCollection().findOne({ followerId: viewerId, followingId: doc.userId }),
        ]);
        isFollowingViewer = !!f1;
        isFollowedByViewer = !!f2;
      }

      responseObj.followerCount = doc.followerCount ?? 0;
      responseObj.followingCount = doc.followingCount ?? 0;
      responseObj.postCount = doc.postCount ?? 0;
      responseObj.isFollowingViewer = isFollowingViewer;
      responseObj.isFollowedByViewer = isFollowedByViewer;

      return reply.status(200).send(responseObj);
    }
  );
};
