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

describe('Relationships - Block / Unblock Module', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;
  let redis: Redis;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const userC = crypto.randomUUID();

  let tokenUserA: string;
  let tokenUserB: string;

  beforeAll(async () => {
    // 1. Setup isolated test MongoDB database
    await mongoDb.closeMongo();
    dbName = `test_${crypto.randomUUID().replace(/-/g, '')}`;
    const mongoUrl = `mongodb://localhost:27017/${dbName}`;
    const conn = await mongoDb.connectMongo(mongoUrl);
    client = conn.client;
    db = conn.db;

    // 2. Setup Redis and JWKS
    redis = getRedisClient();
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    tokenUserA = await createMockAccessToken({ sub: userA, email: 'usera@nebron.io' });
    tokenUserB = await createMockAccessToken({ sub: userB, email: 'userb@nebron.io' });

    // 3. Build Fastify app
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

  it('block sets blocked=true, publishes event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/relationships/${userB}/block`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    expect(res.statusCode).toBe(204);

    // Verify Mongo document
    const doc = await db.collection('relationships').findOne({
      fromUserId: userA,
      toUserId: userB,
    });

    expect(doc).toBeDefined();
    expect(doc!.blocked).toBe(true);
    expect(doc!.muteCalls).toBe(false);
    expect(doc!.muteMessages).toBe(false);
    expect(doc!.updatedAt).toBeInstanceOf(Date);

    // Verify Redis stream event
    const event = await findEvent('core.relationship.blocked', userA, userB);
    expect(event).not.toBeNull();
    expect(event!.payload.fromUserId).toBe(userA);
    expect(event!.payload.toUserId).toBe(userB);

    // Validate event contract
    const validated = parseEvent({ type: event!.type, payload: event!.payload });
    expect(validated.type).toBe('core.relationship.blocked');
  });

  it('block is idempotent (block twice → still blocked, one row)', async () => {
    const countBefore = await db.collection('relationships').countDocuments({
      fromUserId: userA,
      toUserId: userB,
    });
    expect(countBefore).toBe(1);

    const res = await app.inject({
      method: 'POST',
      url: `/relationships/${userB}/block`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    expect(res.statusCode).toBe(204);

    const countAfter = await db.collection('relationships').countDocuments({
      fromUserId: userA,
      toUserId: userB,
    });
    expect(countAfter).toBe(1);

    const doc = await db.collection('relationships').findOne({
      fromUserId: userA,
      toUserId: userB,
    });
    expect(doc!.blocked).toBe(true);
  });

  it('self-block → 400 self_action_not_allowed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/relationships/${userA}/block`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('self_action_not_allowed');
    expect(body.error.message).toBe('Self action is not allowed');
  });

  it('unblock sets blocked=false', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/relationships/${userB}/block`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    expect(res.statusCode).toBe(204);

    const doc = await db.collection('relationships').findOne({
      fromUserId: userA,
      toUserId: userB,
    });
    expect(doc).toBeDefined();
    expect(doc!.blocked).toBe(false);

    // Verify event published
    const event = await findEvent('core.relationship.unblocked', userA, userB);
    expect(event).not.toBeNull();
    expect(event!.payload.fromUserId).toBe(userA);
    expect(event!.payload.toUserId).toBe(userB);

    const validated = parseEvent({ type: event!.type, payload: event!.payload });
    expect(validated.type).toBe('core.relationship.unblocked');
  });

  it('unblock when not blocked is idempotent', async () => {
    // userC was never blocked by userA
    const res = await app.inject({
      method: 'DELETE',
      url: `/relationships/${userC}/block`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    expect(res.statusCode).toBe(204);

    const doc = await db.collection('relationships').findOne({
      fromUserId: userA,
      toUserId: userC,
    });
    expect(doc).toBeDefined();
    expect(doc!.blocked).toBe(false);
  });

  it('GET /relationships/:userId returns blocked state', async () => {
    // Re-block userB
    await app.inject({
      method: 'POST',
      url: `/relationships/${userB}/block`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/relationships/${userB}`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.blocked).toBe(true);
    expect(body.mute).toBeDefined();
    expect(body.mute.calls).toBe(false);
    expect(body.mute.messages).toBe(false);
    expect(body.mute.until).toBeNull();
  });

  it('rejects invalid userId format with 400 invalid_uuid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/relationships/not-a-valid-user-id/block',
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('invalid_uuid');
  });
});
