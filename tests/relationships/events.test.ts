import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import * as mongoDb from '../../src/db/mongo.js';
import { getRedisClient, closeRedis } from '../../src/db/redis.js';
import { jwksService } from '../../src/auth/jwks.js';
import { getOrCreateTestAuthKeys, createMockAccessToken } from '../mocks/jwt.mock.js';
import { parseEvent } from '@nebron/contracts';

describe('Relationships - Event Contracts Module', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;
  let redis: Redis;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();

  let tokenUserA: string;

  beforeAll(async () => {
    await mongoDb.closeMongo();
    dbName = `test_${crypto.randomUUID().replace(/-/g, '')}`;
    const mongoUrl = `mongodb://localhost:27017/${dbName}`;
    const conn = await mongoDb.connectMongo(mongoUrl);
    client = conn.client;
    db = conn.db;

    redis = getRedisClient();
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    tokenUserA = await createMockAccessToken({ sub: userA, email: 'usera@nebron.io' });

    app = await buildApp();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.dropDatabase();
    await mongoDb.closeMongo();
    await closeRedis();
  });

  async function findEvent(type: string, from: string, to: string) {
    const events = await redis.xrevrange('nebron.events', '+', '-', 'COUNT', 50);
    for (const [, fields] of events) {
      const fieldMap: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldMap[fields[i]] = fields[i + 1];
      }
      if (fieldMap.type === type) {
        const payload = JSON.parse(fieldMap.payload);
        if (payload.fromUserId === from && payload.toUserId === to) {
          return { type, payload };
        }
      }
    }
    return null;
  }

  it('block → event published with correct payload and matches schema', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/relationships/${userB}/block`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });
    expect(res.statusCode).toBe(204);

    const event = await findEvent('core.relationship.blocked', userA, userB);
    expect(event).not.toBeNull();
    const { type, payload } = event!;
    expect(type).toBe('core.relationship.blocked');
    expect(payload.fromUserId).toBe(userA);
    expect(payload.toUserId).toBe(userB);
    expect(payload.at).toBeDefined();

    // Verify shape matches shared-contracts schema via parseEvent
    const validated = parseEvent({ type, payload });
    expect(validated.type).toBe('core.relationship.blocked');
    if (validated.type === 'core.relationship.blocked') {
      expect(validated.payload.fromUserId).toBe(userA);
      expect(validated.payload.toUserId).toBe(userB);
    }
  });

  it('unblock → event published and matches schema', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/relationships/${userB}/block`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });
    expect(res.statusCode).toBe(204);

    const event = await findEvent('core.relationship.unblocked', userA, userB);
    expect(event).not.toBeNull();
    const { type, payload } = event!;
    expect(type).toBe('core.relationship.unblocked');
    expect(payload.fromUserId).toBe(userA);
    expect(payload.toUserId).toBe(userB);
    expect(payload.at).toBeDefined();

    const validated = parseEvent({ type, payload });
    expect(validated.type).toBe('core.relationship.unblocked');
    if (validated.type === 'core.relationship.unblocked') {
      expect(validated.payload.fromUserId).toBe(userA);
      expect(validated.payload.toUserId).toBe(userB);
    }
  });

  it('mute → event published with full mute object and matches schema', async () => {
    const futureDate = new Date(Date.now() + 7200000).toISOString();

    const res = await app.inject({
      method: 'POST',
      url: `/relationships/${userB}/mute`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
      payload: {
        calls: true,
        messages: false,
        until: futureDate,
      },
    });
    expect(res.statusCode).toBe(200);

    const event = await findEvent('core.relationship.muted', userA, userB);
    expect(event).not.toBeNull();
    const { type, payload } = event!;
    expect(type).toBe('core.relationship.muted');
    expect(payload.fromUserId).toBe(userA);
    expect(payload.toUserId).toBe(userB);
    expect(payload.mute).toEqual({
      calls: true,
      messages: false,
      until: futureDate,
    });
    expect(payload.at).toBeDefined();

    const validated = parseEvent({ type, payload });
    expect(validated.type).toBe('core.relationship.muted');
    if (validated.type === 'core.relationship.muted') {
      expect(validated.payload.mute.calls).toBe(true);
      expect(validated.payload.mute.messages).toBe(false);
      expect(validated.payload.mute.until).toBe(futureDate);
    }
  });

  it('unmute → event published and matches schema', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/relationships/${userB}/mute`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });
    expect(res.statusCode).toBe(204);

    const event = await findEvent('core.relationship.unmuted', userA, userB);
    expect(event).not.toBeNull();
    const { type, payload } = event!;
    expect(type).toBe('core.relationship.unmuted');
    expect(payload.fromUserId).toBe(userA);
    expect(payload.toUserId).toBe(userB);
    expect(payload.at).toBeDefined();

    const validated = parseEvent({ type, payload });
    expect(validated.type).toBe('core.relationship.unmuted');
    if (validated.type === 'core.relationship.unmuted') {
      expect(validated.payload.fromUserId).toBe(userA);
      expect(validated.payload.toUserId).toBe(userB);
    }
  });
});
