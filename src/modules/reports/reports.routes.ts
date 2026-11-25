import type { FastifyPluginAsync } from 'fastify';
import { authenticateRequest, requireAdmin } from '../../auth/hook.js';
import { defaultReportsService } from './reports.service.js';
import {
  createReportSchema,
  resolveReportSchema,
  banUserSchema,
  getReportsQuerySchema,
  getUsersQuerySchema,
} from './reports.schema.js';
import { env } from '../../config/env.js';
import { ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { getProfilesCollection } from '../../db/mongo.js';

export const reportRoutes: FastifyPluginAsync = async (app) => {
  // 1. User-facing report creation
  app.post(
    '/reports',
    {
      preHandler: [authenticateRequest],
    },
    async (request, reply) => {
      const parsedBody = createReportSchema.parse(request.body);
      const reporterId = request.user.userId;

      const result = await defaultReportsService.createReport(reporterId, parsedBody);
      return reply.status(201).send(result);
    }
  );

  // 2. Admin: Get reports list
  app.get(
    '/admin/reports',
    {
      preHandler: [requireAdmin],
    },
    async (request, reply) => {
      const query = getReportsQuerySchema.parse(request.query);
      const result = await defaultReportsService.getAdminReports(query);
      return reply.status(200).send(result);
    }
  );

  // 3. Admin: Get single report
  app.get<{ Params: { id: string } }>(
    '/admin/reports/:id',
    {
      preHandler: [requireAdmin],
    },
    async (request, reply) => {
      const report = await defaultReportsService.getAdminReportById(request.params.id);
      return reply.status(200).send({ report });
    }
  );

  // 4. Admin: Resolve report
  app.post<{ Params: { id: string } }>(
    '/admin/reports/:id/resolve',
    {
      preHandler: [requireAdmin],
    },
    async (request, reply) => {
      const parsedBody = resolveReportSchema.parse(request.body);
      const adminId = request.user.userId;

      const updated = await defaultReportsService.resolveReport(
        adminId,
        request.params.id,
        parsedBody.action,
        parsedBody.note
      );

      return reply.status(200).send({ report: updated });
    }
  );

  // 5. Admin: Users list & search
  app.get(
    '/admin/users',
    {
      preHandler: [requireAdmin],
    },
    async (request, reply) => {
      const query = getUsersQuerySchema.parse(request.query);
      const result = await defaultReportsService.getAdminUsers(query);
      return reply.status(200).send(result);
    }
  );

  // 6. Admin: Single user detail
  app.get<{ Params: { userId: string } }>(
    '/admin/users/:userId',
    {
      preHandler: [requireAdmin],
    },
    async (request, reply) => {
      const result = await defaultReportsService.getAdminUserDetail(request.params.userId);
      return reply.status(200).send(result);
    }
  );

  // 7. Admin: Ban user
  app.post<{ Params: { userId: string } }>(
    '/admin/users/:userId/ban',
    {
      preHandler: [requireAdmin],
    },
    async (request, reply) => {
      const parsedBody = banUserSchema.parse(request.body);
      const adminId = request.user.userId;

      await defaultReportsService.banUser(adminId, request.params.userId, parsedBody.reason);
      return reply.status(200).send({ success: true });
    }
  );

  // 8. Admin: Unban user
  app.post<{ Params: { userId: string } }>(
    '/admin/users/:userId/unban',
    {
      preHandler: [requireAdmin],
    },
    async (request, reply) => {
      const adminId = request.user.userId;
      await defaultReportsService.unbanUser(adminId, request.params.userId);
      return reply.status(200).send({ success: true });
    }
  );

  // 9. Admin: Promote user
  app.post<{ Params: { userId: string } }>(
    '/admin/users/:userId/promote',
    {
      preHandler: [requireAdmin],
    },
    async (request, reply) => {
      const adminId = request.user.userId;
      await defaultReportsService.promoteUser(adminId, request.params.userId);
      return reply.status(200).send({ success: true });
    }
  );

  // 10. Admin: Demote user
  app.post<{ Params: { userId: string } }>(
    '/admin/users/:userId/demote',
    {
      preHandler: [requireAdmin],
    },
    async (request, reply) => {
      const adminId = request.user.userId;
      await defaultReportsService.demoteUser(adminId, request.params.userId);
      return reply.status(200).send({ success: true });
    }
  );

  // 11. Admin: Dashboard Stats
  app.get(
    '/admin/stats',
    {
      preHandler: [requireAdmin],
    },
    async (_request, reply) => {
      const stats = await defaultReportsService.getAdminStats();
      return reply.status(200).send(stats);
    }
  );

  // 12. Admin: Delete post bypassing author check
  app.delete<{ Params: { id: string } }>(
    '/admin/posts/:id',
    {
      preHandler: [requireAdmin],
    },
    async (request, reply) => {
      const adminId = request.user.userId;
      await defaultReportsService.adminDeletePost(adminId, request.params.id);
      return reply.status(200).send({ success: true });
    }
  );

  // 13. Admin: Delete message bypassing author check
  app.delete<{ Params: { conversationId: string; messageId: string } }>(
    '/admin/messages/:conversationId/:messageId',
    {
      preHandler: [requireAdmin],
    },
    async (request, reply) => {
      const adminId = request.user.userId;
      await defaultReportsService.adminDeleteMessage(
        adminId,
        request.params.conversationId,
        request.params.messageId
      );
      return reply.status(200).send({ success: true });
    }
  );

  // 14. Internal: Ban status lookup for other microservices (chat, voice)
  app.get<{ Params: { userId: string } }>(
    '/internal/users/:userId/ban-status',
    async (request, reply) => {
      const token =
        (request.headers['x-internal-token'] as string) ||
        (request.headers.authorization?.replace(/^Bearer\s+/i, '') as string);

      if (!token || token !== env.INTERNAL_TOKEN) {
        throw new ForbiddenError('Invalid internal token', 'forbidden');
      }

      const profile = await getProfilesCollection().findOne({ userId: request.params.userId });
      if (!profile) {
        throw new NotFoundError('User not found', 'user_not_found');
      }

      return reply.status(200).send({
        userId: profile.userId,
        isBanned: Boolean(profile.isBanned),
        bannedAt: profile.bannedAt ? profile.bannedAt.toISOString() : null,
        bannedReason: profile.bannedReason || null,
      });
    }
  );
};
