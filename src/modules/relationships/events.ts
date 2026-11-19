import { Redis } from 'ioredis';
import { getRedisClient } from '../../db/redis.js';
import type {
  CoreRelationshipBlocked,
  CoreRelationshipUnblocked,
  CoreRelationshipMuted,
  CoreRelationshipUnmuted,
} from '@zenuxs/contracts';

export class RelationshipEventPublisher {
  private redis: Redis;
  private readonly streamKey: string;

  constructor(redis?: Redis, streamKey: string = 'nebron.events') {
    this.redis = redis ?? getRedisClient();
    this.streamKey = streamKey;
  }

  async publishBlocked(payload: CoreRelationshipBlocked): Promise<void> {
    await this.redis.xadd(
      this.streamKey,
      '*',
      'type',
      'core.relationship.blocked',
      'payload',
      JSON.stringify(payload)
    );
  }

  async publishUnblocked(payload: CoreRelationshipUnblocked): Promise<void> {
    await this.redis.xadd(
      this.streamKey,
      '*',
      'type',
      'core.relationship.unblocked',
      'payload',
      JSON.stringify(payload)
    );
  }

  async publishMuted(payload: CoreRelationshipMuted): Promise<void> {
    await this.redis.xadd(
      this.streamKey,
      '*',
      'type',
      'core.relationship.muted',
      'payload',
      JSON.stringify(payload)
    );
  }

  async publishUnmuted(payload: CoreRelationshipUnmuted): Promise<void> {
    await this.redis.xadd(
      this.streamKey,
      '*',
      'type',
      'core.relationship.unmuted',
      'payload',
      JSON.stringify(payload)
    );
  }
}

export const defaultRelationshipEventPublisher = new RelationshipEventPublisher();
