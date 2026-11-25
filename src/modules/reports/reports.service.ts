import { ObjectId } from 'mongodb';
import { Redis } from 'ioredis';
import {
  getReportsCollection,
  getAdminActionsCollection,
  getProfilesCollection,
  getPostsCollection,
  getCommentsCollection,
  type ReportDocument,
  type AdminActionDocument,
  type ProfileDocument,
  type ReportTargetType,
  type ReportReason,
  type ReportStatus,
} from '../../db/mongo.js';
import { getRedisClient } from '../../db/redis.js';
import { env } from '../../config/env.js';
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
} from '../../utils/errors.js';
import { computePublicUrl } from '../../lib/r2.js';
import { defaultEventPublisher } from '../events/publisher.js';
import { defaultPostService } from '../social/posts/service.js';
import { defaultCommentService } from '../social/comments/service.js';
import { sendAdminReportNotification } from './email.js';

export interface CreateReportInput {
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  details?: string;
}

export class ReportsService {
  private redis: Redis;

  constructor(redis?: Redis) {
    this.redis = redis ?? getRedisClient();
  }

  async createReport(
    reporterId: string,
    input: CreateReportInput
  ): Promise<{ reportId: string; status: ReportStatus }> {
    const today = new Date().toISOString().slice(0, 10);
    const rateLimitKey = `rate_limit:reports:${reporterId}:${today}`;

    // 1. Rate limit: 10 reports / day per reporter
    const currentCount = await this.redis.incr(rateLimitKey);
    if (currentCount === 1) {
      await this.redis.expire(rateLimitKey, 86400);
    }
    if (currentCount > 10) {
      throw new RateLimitError('Report rate limit exceeded (maximum 10 reports per day)');
    }

    const reportsColl = getReportsCollection();
    const profilesColl = getProfilesCollection();

    // 2. Duplicate check: same reporter + target within 24h -> 429 already_reported
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const existing = await reportsColl.findOne({
      reporterId,
      targetType: input.targetType,
      targetId: input.targetId,
      createdAt: { $gte: twentyFourHoursAgo },
    });

    if (existing) {
      throw new AppError(429, 'already_reported', 'You have already reported this content in the last 24 hours');
    }

    // 3. Look up targetOwnerId & prevent self-reporting
    let targetOwnerId: string;

    if (input.targetType === 'user') {
      targetOwnerId = input.targetId;
      const targetUser = await profilesColl.findOne({ userId: targetOwnerId });
      if (!targetUser) {
        throw new NotFoundError('Target user not found', 'user_not_found');
      }
    } else if (input.targetType === 'post') {
      let postOid: ObjectId;
      try {
        postOid = new ObjectId(input.targetId);
      } catch {
        throw new NotFoundError('Post not found', 'post_not_found');
      }
      const post = await getPostsCollection().findOne({ _id: postOid, deleted: false });
      if (!post) {
        throw new NotFoundError('Post not found', 'post_not_found');
      }
      targetOwnerId = post.authorId;
    } else if (input.targetType === 'comment') {
      let commentOid: ObjectId;
      try {
        commentOid = new ObjectId(input.targetId);
      } catch {
        throw new NotFoundError('Comment not found', 'comment_not_found');
      }
      const comment = await getCommentsCollection().findOne({ _id: commentOid, deleted: false });
      if (!comment) {
        throw new NotFoundError('Comment not found', 'comment_not_found');
      }
      targetOwnerId = comment.authorId;
    } else if (input.targetType === 'message') {
      // Format can be "conversationId:messageId" or just messageId
      const parts = input.targetId.split(':');
      if (parts.length === 2) {
        const [conversationId, messageId] = parts;
        try {
          const res = await fetch(
            `${env.CHAT_SERVICE_URL}/internal/conversations/${conversationId}/messages/${messageId}`,
            {
              headers: { 'x-internal-token': env.INTERNAL_TOKEN },
              signal: AbortSignal.timeout(3000),
            }
          );
          if (res.ok) {
            const data = (await res.json()) as any;
            targetOwnerId = data.message?.senderId || 'unknown';
          } else {
            targetOwnerId = 'unknown';
          }
        } catch {
          targetOwnerId = 'unknown';
        }
      } else {
        targetOwnerId = 'unknown';
      }
    } else {
      throw new BadRequestError('Invalid targetType', 'invalid_target_type');
    }

    if (targetOwnerId === reporterId) {
      throw new BadRequestError('Cannot report your own content or account', 'cannot_report_self');
    }

    // 4. Insert report with status='pending'
    const now = new Date();
    const doc: ReportDocument = {
      reporterId,
      targetType: input.targetType,
      targetId: input.targetId,
      targetOwnerId,
      reason: input.reason,
      details: input.details,
      status: 'pending',
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      createdAt: now,
    };

    const insertResult = await reportsColl.insertOne(doc);
    const reportId = insertResult.insertedId.toString();

    // 5. Send notification email if configured
    sendAdminReportNotification({
      reportId,
      reporterId,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      details: input.details,
      createdAt: now,
    }).catch((err) => console.error('[ReportsService] Error sending email:', err));

    // 6. Publish core.report.created event
    await defaultEventPublisher.publishReportCreated({
      reportId,
      reporterId,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      at: now.toISOString(),
    });

    return {
      reportId,
      status: 'pending',
    };
  }

  async getAdminReports(params: {
    status?: ReportStatus;
    targetType?: ReportTargetType;
    limit?: number;
    before?: string;
  }): Promise<{ reports: any[]; nextCursor: string | null }> {
    const limit = Math.min(params.limit || 30, 100);
    const query: Record<string, any> = {};

    if (params.status) {
      query.status = params.status;
    }
    if (params.targetType) {
      query.targetType = params.targetType;
    }
    if (params.before) {
      query.createdAt = { $lt: new Date(params.before) };
    }

    const reportsColl = getReportsCollection();
    const docs = await reportsColl
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = docs.length > limit;
    const results = hasMore ? docs.slice(0, limit) : docs;
    const nextCursor = hasMore ? results[results.length - 1].createdAt.toISOString() : null;

    const enriched = await Promise.all(results.map((r) => this.enrichReport(r)));

    return {
      reports: enriched,
      nextCursor,
    };
  }

  async getAdminReportById(id: string): Promise<any> {
    let oid: ObjectId;
    try {
      oid = new ObjectId(id);
    } catch {
      throw new NotFoundError('Report not found', 'report_not_found');
    }

    const report = await getReportsCollection().findOne({ _id: oid });
    if (!report) {
      throw new NotFoundError('Report not found', 'report_not_found');
    }

    return this.enrichReport(report);
  }

  private async enrichReport(report: ReportDocument): Promise<any> {
    const profilesColl = getProfilesCollection();

    const [reporterProfile, targetOwnerProfile] = await Promise.all([
      profilesColl.findOne({ userId: report.reporterId }),
      report.targetOwnerId !== 'unknown'
        ? profilesColl.findOne({ userId: report.targetOwnerId })
        : null,
    ]);

    let targetContent: any = null;

    if (report.targetType === 'user') {
      targetContent = targetOwnerProfile
        ? {
            userId: targetOwnerProfile.userId,
            username: targetOwnerProfile.username,
            name: targetOwnerProfile.name,
            bio: targetOwnerProfile.bio,
            avatarUrl: computePublicUrl(targetOwnerProfile.avatarKey, targetOwnerProfile.updatedAt),
          }
        : null;
    } else if (report.targetType === 'post') {
      try {
        const post = await getPostsCollection().findOne({ _id: new ObjectId(report.targetId) });
        if (post) {
          targetContent = {
            id: post._id.toString(),
            body: post.body,
            imageUrl: post.imageUrl || computePublicUrl(post.imageKey, post.updatedAt),
            deleted: post.deleted,
            createdAt: post.createdAt,
          };
        }
      } catch {
        targetContent = null;
      }
    } else if (report.targetType === 'comment') {
      try {
        const comment = await getCommentsCollection().findOne({ _id: new ObjectId(report.targetId) });
        if (comment) {
          targetContent = {
            id: comment._id.toString(),
            postId: comment.postId.toString(),
            body: comment.body,
            deleted: comment.deleted,
            createdAt: comment.createdAt,
          };
        }
      } catch {
        targetContent = null;
      }
    } else if (report.targetType === 'message') {
      const parts = report.targetId.split(':');
      if (parts.length === 2) {
        const [conversationId, messageId] = parts;
        try {
          const res = await fetch(
            `${env.CHAT_SERVICE_URL}/internal/conversations/${conversationId}/messages/${messageId}`,
            {
              headers: { 'x-internal-token': env.INTERNAL_TOKEN },
              signal: AbortSignal.timeout(2000),
            }
          );
          if (res.ok) {
            const data = (await res.json()) as any;
            targetContent = data.message;
          }
        } catch {
          targetContent = { id: messageId, conversationId };
        }
      } else {
        targetContent = { id: report.targetId };
      }
    }

    return {
      id: report._id.toString(),
      reporterId: report.reporterId,
      targetType: report.targetType,
      targetId: report.targetId,
      targetOwnerId: report.targetOwnerId,
      reason: report.reason,
      details: report.details || null,
      status: report.status,
      resolvedBy: report.resolvedBy,
      resolvedAt: report.resolvedAt ? report.resolvedAt.toISOString() : null,
      resolutionNote: report.resolutionNote,
      createdAt: report.createdAt.toISOString(),
      reporter: reporterProfile
        ? {
            userId: reporterProfile.userId,
            username: reporterProfile.username,
            name: reporterProfile.name,
            avatarUrl: computePublicUrl(reporterProfile.avatarKey, reporterProfile.updatedAt),
          }
        : { userId: report.reporterId, username: 'unknown', name: null, avatarUrl: null },
      targetOwner: targetOwnerProfile
        ? {
            userId: targetOwnerProfile.userId,
            username: targetOwnerProfile.username,
            name: targetOwnerProfile.name,
            avatarUrl: computePublicUrl(targetOwnerProfile.avatarKey, targetOwnerProfile.updatedAt),
          }
        : { userId: report.targetOwnerId, username: 'unknown', name: null, avatarUrl: null },
      target: targetContent,
    };
  }

  async resolveReport(
    adminId: string,
    reportIdStr: string,
    action:
      | 'dismiss'
      | 'delete_post'
      | 'delete_comment'
      | 'delete_message'
      | 'ban_user'
      | 'warn_user',
    note?: string
  ): Promise<any> {
    let oid: ObjectId;
    try {
      oid = new ObjectId(reportIdStr);
    } catch {
      throw new NotFoundError('Report not found', 'report_not_found');
    }

    const reportsColl = getReportsCollection();
    const report = await reportsColl.findOne({ _id: oid });
    if (!report) {
      throw new NotFoundError('Report not found', 'report_not_found');
    }

    const now = new Date();

    // Execute corresponding action
    if (action === 'delete_post') {
      try {
        await defaultPostService.adminDeletePost(report.targetId);
      } catch (err: any) {
        if (err.code !== 'post_not_found') throw err;
      }
      await this.logAdminAction(adminId, 'delete_post', 'post', report.targetId, {
        reportId: reportIdStr,
        note,
      });
    } else if (action === 'delete_comment') {
      try {
        await defaultCommentService.adminDeleteComment(report.targetId);
      } catch (err: any) {
        if (err.code !== 'comment_not_found') throw err;
      }
      await this.logAdminAction(adminId, 'delete_comment', 'comment', report.targetId, {
        reportId: reportIdStr,
        note,
      });
    } else if (action === 'delete_message') {
      const parts = report.targetId.split(':');
      if (parts.length === 2) {
        const [conversationId, messageId] = parts;
        try {
          await fetch(
            `${env.CHAT_SERVICE_URL}/internal/conversations/${conversationId}/messages/${messageId}`,
            {
              method: 'DELETE',
              headers: { 'x-internal-token': env.INTERNAL_TOKEN },
              signal: AbortSignal.timeout(3000),
            }
          );
        } catch (err: any) {
          console.error('[ReportsService] Error deleting message via chat-service:', err.message);
        }
      }
      await this.logAdminAction(adminId, 'delete_post', 'report', report.targetId, {
        action: 'delete_message',
        reportId: reportIdStr,
        note,
      });
    } else if (action === 'ban_user') {
      const targetUserId =
        report.targetType === 'user' ? report.targetId : report.targetOwnerId;
      if (targetUserId && targetUserId !== 'unknown') {
        await this.banUser(adminId, targetUserId, note || 'Violating community guidelines');
      }
    } else if (action === 'warn_user') {
      const targetUserId =
        report.targetType === 'user' ? report.targetId : report.targetOwnerId;
      await this.logAdminAction(adminId, 'warn_user', 'user', targetUserId, {
        reportId: reportIdStr,
        note,
      });
    }

    const newStatus: ReportStatus = action === 'dismiss' ? 'dismissed' : 'resolved';

    await reportsColl.updateOne(
      { _id: oid },
      {
        $set: {
          status: newStatus,
          resolvedBy: adminId,
          resolvedAt: now,
          resolutionNote: note || null,
        },
      }
    );

    // Audit log for report resolution/dismissal
    await this.logAdminAction(
      adminId,
      action === 'dismiss' ? 'dismiss_report' : 'resolve_report',
      'report',
      reportIdStr,
      { action, note }
    );

    // Publish event
    await defaultEventPublisher.publishReportResolved({
      reportId: reportIdStr,
      resolvedBy: adminId,
      action,
      at: now.toISOString(),
    });

    return this.getAdminReportById(reportIdStr);
  }

  async getAdminUsers(params: {
    q?: string;
    limit?: number;
    before?: string;
  }): Promise<{ users: any[]; nextCursor: string | null }> {
    const limit = Math.min(params.limit || 30, 100);
    const query: Record<string, any> = {};

    if (params.q) {
      const escaped = params.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      query.$or = [{ username: regex }, { name: regex }, { email: regex }];
    }

    if (params.before) {
      query.createdAt = { $lt: new Date(params.before) };
    }

    const profilesColl = getProfilesCollection();
    const reportsColl = getReportsCollection();

    const docs = await profilesColl
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = docs.length > limit;
    const results = hasMore ? docs.slice(0, limit) : docs;
    const nextCursor = hasMore ? results[results.length - 1].createdAt.toISOString() : null;

    const userIds = results.map((u) => u.userId);
    const reportCounts = await reportsColl
      .aggregate<{ _id: string; count: number }>([
        { $match: { targetOwnerId: { $in: userIds } } },
        { $group: { _id: '$targetOwnerId', count: { $sum: 1 } } },
      ])
      .toArray();

    const reportCountMap = new Map<string, number>();
    for (const r of reportCounts) {
      reportCountMap.set(r._id, r.count);
    }

    const users = results.map((u) => ({
      userId: u.userId,
      username: u.username,
      name: u.name,
      email: u.email || '',
      avatarUrl: computePublicUrl(u.avatarKey, u.updatedAt),
      isAdmin: Boolean(u.isAdmin),
      isBanned: Boolean(u.isBanned),
      bannedAt: u.bannedAt ? u.bannedAt.toISOString() : null,
      bannedReason: u.bannedReason || null,
      createdAt: u.createdAt.toISOString(),
      reportCount: reportCountMap.get(u.userId) || 0,
    }));

    return {
      users,
      nextCursor,
    };
  }

  async getAdminUserDetail(userId: string): Promise<any> {
    const profilesColl = getProfilesCollection();
    const reportsColl = getReportsCollection();
    const adminActionsColl = getAdminActionsCollection();
    const postsColl = getPostsCollection();

    const profile = await profilesColl.findOne({ userId });
    if (!profile) {
      throw new NotFoundError('User not found', 'user_not_found');
    }

    const [reports, actions, posts] = await Promise.all([
      reportsColl
        .find({
          $or: [{ targetOwnerId: userId }, { targetType: 'user', targetId: userId }],
        })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray(),
      adminActionsColl
        .find({ targetId: userId })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray(),
      postsColl
        .find({ authorId: userId, deleted: false })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray(),
    ]);

    return {
      profile: {
        userId: profile.userId,
        username: profile.username,
        name: profile.name,
        email: profile.email || '',
        bio: profile.bio,
        about: profile.about,
        language: profile.language,
        theme: profile.theme,
        avatarUrl: computePublicUrl(profile.avatarKey, profile.updatedAt),
        bannerUrl: computePublicUrl(profile.bannerKey, profile.updatedAt),
        isAdmin: Boolean(profile.isAdmin),
        isBanned: Boolean(profile.isBanned),
        bannedAt: profile.bannedAt ? profile.bannedAt.toISOString() : null,
        bannedReason: profile.bannedReason || null,
        followerCount: profile.followerCount || 0,
        followingCount: profile.followingCount || 0,
        postCount: profile.postCount || 0,
        createdAt: profile.createdAt.toISOString(),
      },
      reports: reports.map((r) => ({
        id: r._id.toString(),
        reporterId: r.reporterId,
        targetType: r.targetType,
        targetId: r.targetId,
        reason: r.reason,
        details: r.details,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
      actions: actions.map((a) => ({
        id: a._id.toString(),
        adminId: a.adminId,
        action: a.action,
        targetType: a.targetType,
        targetId: a.targetId,
        details: a.details,
        createdAt: a.createdAt.toISOString(),
      })),
      recentPosts: posts.map((p) => ({
        id: p._id.toString(),
        body: p.body,
        imageUrl: p.imageUrl || computePublicUrl(p.imageKey, p.updatedAt),
        likeCount: p.likeCount,
        commentCount: p.commentCount,
        createdAt: p.createdAt.toISOString(),
      })),
    };
  }

  async banUser(adminId: string, targetUserId: string, reason: string): Promise<void> {
    const profilesColl = getProfilesCollection();
    const target = await profilesColl.findOne({ userId: targetUserId });
    if (!target) {
      throw new NotFoundError('User not found', 'user_not_found');
    }

    if (target.isAdmin) {
      throw new ForbiddenError('Cannot ban an administrator', 'cannot_ban_admin');
    }

    const now = new Date();
    await profilesColl.updateOne(
      { userId: targetUserId },
      {
        $set: {
          isBanned: true,
          bannedAt: now,
          bannedReason: reason,
        },
      }
    );

    // Revoke sessions in auth-service
    try {
      await fetch(`${env.AUTH_SERVICE_URL}/internal/users/${targetUserId}/revoke-sessions`, {
        method: 'POST',
        headers: {
          'x-internal-token': env.INTERNAL_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (err: any) {
      console.error('[ReportsService] Error revoking sessions in auth-service:', err.message);
    }

    // Update Redis cache
    await this.redis.set(
      `user:banned:${targetUserId}`,
      JSON.stringify({ banned: true, reason }),
      'EX',
      86400 * 30
    );

    // Audit log
    await this.logAdminAction(adminId, 'ban_user', 'user', targetUserId, { reason });

    // Publish event
    await defaultEventPublisher.publishUserBanned({
      userId: targetUserId,
      bannedBy: adminId,
      reason,
      at: now.toISOString(),
    });
  }

  async unbanUser(adminId: string, targetUserId: string): Promise<void> {
    const profilesColl = getProfilesCollection();
    const target = await profilesColl.findOne({ userId: targetUserId });
    if (!target) {
      throw new NotFoundError('User not found', 'user_not_found');
    }

    const now = new Date();
    await profilesColl.updateOne(
      { userId: targetUserId },
      {
        $set: {
          isBanned: false,
          bannedAt: null,
          bannedReason: null,
        },
      }
    );

    // Clear Redis cache
    await this.redis.del(`user:banned:${targetUserId}`);

    // Audit log
    await this.logAdminAction(adminId, 'resolve_report', 'user', targetUserId, {
      action: 'unban_user',
    });

    // Publish event
    await defaultEventPublisher.publishUserUnbanned({
      userId: targetUserId,
      unbannedBy: adminId,
      at: now.toISOString(),
    });
  }

  async promoteUser(adminId: string, targetUserId: string): Promise<void> {
    const profilesColl = getProfilesCollection();

    // Check if caller is super admin (oldest admin in DB)
    const oldestAdmin = await profilesColl
      .find({ isAdmin: true })
      .sort({ createdAt: 1 })
      .limit(1)
      .toArray();

    if (!oldestAdmin.length || oldestAdmin[0].userId !== adminId) {
      throw new ForbiddenError(
        'Only the super admin can promote administrators',
        'super_admin_only'
      );
    }

    const target = await profilesColl.findOne({ userId: targetUserId });
    if (!target) {
      throw new NotFoundError('User not found', 'user_not_found');
    }

    await profilesColl.updateOne({ userId: targetUserId }, { $set: { isAdmin: true } });
    await this.logAdminAction(adminId, 'resolve_report', 'user', targetUserId, {
      action: 'promote_admin',
    });
  }

  async demoteUser(adminId: string, targetUserId: string): Promise<void> {
    const profilesColl = getProfilesCollection();

    const oldestAdmin = await profilesColl
      .find({ isAdmin: true })
      .sort({ createdAt: 1 })
      .limit(1)
      .toArray();

    if (!oldestAdmin.length || oldestAdmin[0].userId !== adminId) {
      throw new ForbiddenError(
        'Only the super admin can demote administrators',
        'super_admin_only'
      );
    }

    if (oldestAdmin[0].userId === targetUserId) {
      throw new BadRequestError('Cannot demote the super admin', 'cannot_demote_super_admin');
    }

    const target = await profilesColl.findOne({ userId: targetUserId });
    if (!target) {
      throw new NotFoundError('User not found', 'user_not_found');
    }

    await profilesColl.updateOne({ userId: targetUserId }, { $set: { isAdmin: false } });
    await this.logAdminAction(adminId, 'resolve_report', 'user', targetUserId, {
      action: 'demote_admin',
    });
  }

  async getAdminStats(): Promise<any> {
    const profilesColl = getProfilesCollection();
    const postsColl = getPostsCollection();
    const reportsColl = getReportsCollection();

    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    const [
      totalUsers,
      bannedUsers,
      activeToday,
      totalPosts,
      postsToday,
      pendingReports,
      resolvedReportsToday,
    ] = await Promise.all([
      profilesColl.countDocuments(),
      profilesColl.countDocuments({ isBanned: true }),
      profilesColl.countDocuments({ updatedAt: { $gte: startOfToday } }),
      postsColl.countDocuments({ deleted: false }),
      postsColl.countDocuments({ deleted: false, createdAt: { $gte: startOfToday } }),
      reportsColl.countDocuments({ status: 'pending' }),
      reportsColl.countDocuments({
        status: { $in: ['resolved', 'dismissed'] },
        resolvedAt: { $gte: startOfToday },
      }),
    ]);

    // Cross-service call to chat-service
    let messagesToday = 0;
    try {
      const res = await fetch(`${env.CHAT_SERVICE_URL}/internal/stats`, {
        headers: { 'x-internal-token': env.INTERNAL_TOKEN },
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        messagesToday = data.messages?.today ?? data.today ?? 0;
      }
    } catch {
      messagesToday = 0;
    }

    // Cross-service call to voice-service
    let callsToday = 0;
    try {
      const res = await fetch(`${env.VOICE_SERVICE_URL}/internal/stats`, {
        headers: { 'x-internal-token': env.INTERNAL_TOKEN },
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        callsToday = data.calls?.today ?? data.today ?? 0;
      }
    } catch {
      callsToday = 0;
    }

    return {
      users: {
        total: totalUsers,
        activeToday: Math.max(activeToday, 1),
        banned: bannedUsers,
      },
      posts: {
        total: totalPosts,
        today: postsToday,
      },
      reports: {
        pending: pendingReports,
        resolvedToday: resolvedReportsToday,
      },
      messages: {
        today: messagesToday,
      },
      calls: {
        today: callsToday,
      },
    };
  }

  async adminDeletePost(adminId: string, postId: string): Promise<void> {
    await defaultPostService.adminDeletePost(postId);
    await this.logAdminAction(adminId, 'delete_post', 'post', postId, {});
  }

  async adminDeleteMessage(
    adminId: string,
    conversationId: string,
    messageId: string
  ): Promise<void> {
    await fetch(
      `${env.CHAT_SERVICE_URL}/internal/conversations/${conversationId}/messages/${messageId}`,
      {
        method: 'DELETE',
        headers: { 'x-internal-token': env.INTERNAL_TOKEN },
        signal: AbortSignal.timeout(3000),
      }
    );
    await this.logAdminAction(adminId, 'delete_post', 'report', `${conversationId}:${messageId}`, {
      action: 'delete_message',
      conversationId,
      messageId,
    });
  }

  async logAdminAction(
    adminId: string,
    action: any,
    targetType: any,
    targetId: string,
    details: Record<string, any>
  ): Promise<void> {
    const adminActionsColl = getAdminActionsCollection();
    const doc: AdminActionDocument = {
      adminId,
      action,
      targetType,
      targetId,
      details,
      createdAt: new Date(),
    };
    await adminActionsColl.insertOne(doc);
  }
}

export const defaultReportsService = new ReportsService();
