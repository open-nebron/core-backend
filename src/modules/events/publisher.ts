import { Redis } from 'ioredis';
import { getRedisClient } from '../../db/redis.js';
import type {
  CoreRelationshipBlocked,
  CoreRelationshipUnblocked,
  CoreRelationshipMuted,
  CoreRelationshipUnmuted,
  CoreReportCreated,
  CoreReportResolved,
  CoreUserBanned,
  CoreUserUnbanned,
} from '@nebron/contracts';

export class RedisStreamsEventPublisher {
  private redis: Redis;
  private readonly streamKey: string;

  constructor(redis?: Redis, streamKey: string = 'nebron.events') {
    this.redis = redis ?? getRedisClient();
    this.streamKey = streamKey;
  }

  async publish(type: string, payload: unknown): Promise<void> {
    await this.redis.xadd(
      this.streamKey,
      '*',
      'type',
      type,
      'payload',
      JSON.stringify(payload)
    );
  }

  async publishRelationshipBlocked(payload: CoreRelationshipBlocked): Promise<void> {
    await this.publish('core.relationship.blocked', payload);
  }

  async publishRelationshipUnblocked(payload: CoreRelationshipUnblocked): Promise<void> {
    await this.publish('core.relationship.unblocked', payload);
  }

  async publishRelationshipMuted(payload: CoreRelationshipMuted): Promise<void> {
    await this.publish('core.relationship.muted', payload);
  }

  async publishRelationshipUnmuted(payload: CoreRelationshipUnmuted): Promise<void> {
    await this.publish('core.relationship.unmuted', payload);
  }

  async publishReportCreated(payload: CoreReportCreated): Promise<void> {
    await this.publish('core.report.created', payload);
  }

  async publishReportResolved(payload: CoreReportResolved): Promise<void> {
    await this.publish('core.report.resolved', payload);
  }

  async publishUserBanned(payload: CoreUserBanned): Promise<void> {
    await this.publish('core.user.banned', payload);
  }

  async publishUserUnbanned(payload: CoreUserUnbanned): Promise<void> {
    await this.publish('core.user.unbanned', payload);
  }
}

export const defaultEventPublisher = new RedisStreamsEventPublisher();
