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

describe('Relationships - Mute / Unmute Module', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;
  let redis: Redis;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const userC = crypto.randomUUID();

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

  it('mute with calls only → muteCalls=true, muteMessages=false', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/relationships/${userB}/mute`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
      payload: {
        calls: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.calls).toBe(true);
    expect(body.messages).toBe(false);
    expect(body.until).toBeNull();

    const doc = await db.collection('relationships').findOne({
      fromUserId: userA,
      toUserId: userB,
    });
    expect(doc).toBeDefined();
    expect(doc!.muteCalls).toBe(true);
    expect(doc!.muteMessages).toBe(false);
    expect(doc!.muteUntil).toBeNull();
  });

  it('mute with messages only → muteMessages=true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/relationships/${userC}/mute`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
      payload: {
        messages: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.calls).toBe(false);
    expect(body.messages).toBe(true);
    expect(body.until).toBeNull();

    const doc = await db.collection('relationships').findOne({
      fromUserId: userA,
      toUserId: userC,
    });
    expect(doc).toBeDefined();
    expect(doc!.muteCalls).toBe(false);
    expect(doc!.muteMessages).toBe(true);
  });

  it('mute with both → both true', async () => {
    const target = crypto.randomUUID();
    const res = await app.inject({
      method: 'POST',
      url: `/relationships/${target}/mute`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
      payload: {
        calls: true,
        messages: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.calls).toBe(true);
    expect(body.messages).toBe(true);
    expect(body.until).toBeNull();

    const doc = await db.collection('relationships').findOne({
      fromUserId: userA,
      toUserId: target,
    });
    expect(doc!.muteCalls).toBe(true);
    expect(doc!.muteMessages).toBe(true);
  });

  it('mute with until future → muteUntil set', async () => {
    const target = crypto.randomUUID();
    const futureDate = new Date(Date.now() + 86400000).toISOString();

    const res = await app.inject({
      method: 'POST',
      url: `/relationships/${target}/mute`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
      payload: {
        calls: true,
        until: futureDate,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.calls).toBe(true);
    expect(body.messages).toBe(false);
    expect(body.until).toBe(futureDate);

    const doc = await db.collection('relationships').findOne({
      fromUserId: userA,
      toUserId: target,
    });
    expect(doc!.muteUntil).toBeInstanceOf(Date);
    expect(doc!.muteUntil!.toISOString()).toBe(futureDate);
  });

  it('mute with until past → 400 invalid_until', async () => {
    const target = crypto.randomUUID();
    const pastDate = new Date(Date.now() - 3600000).toISOString();

    const res = await app.inject({
      method: 'POST',
      url: `/relationships/${target}/mute`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
      payload: {
        calls: true,
        until: pastDate,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('invalid_until');
  });

  it('mute with empty body → 400 empty_mute', async () => {
    const target = crypto.randomUUID();

    // 1. Completely empty object
    const resEmpty = await app.inject({
      method: 'POST',
      url: `/relationships/${target}/mute`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
      payload: {},
    });
    expect(resEmpty.statusCode).toBe(400);
    expect(resEmpty.json().error.code).toBe('empty_mute');

    // 2. Body with both false and no until
    const resFalse = await app.inject({
      method: 'POST',
      url: `/relationships/${target}/mute`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
      payload: {
        calls: false,
        messages: false,
      },
    });
    expect(resFalse.statusCode).toBe(400);
    expect(resFalse.json().error.code).toBe('empty_mute');

    // 3. Body with until: null
    const resNullUntil = await app.inject({
      method: 'POST',
      url: `/relationships/${target}/mute`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
      payload: {
        until: null,
      },
    });
    expect(resNullUntil.statusCode).toBe(400);
    expect(resNullUntil.json().error.code).toBe('empty_mute');
  });

  it('unmute clears all', async () => {
    const target = crypto.randomUUID();
    // First mute both
    await app.inject({
      method: 'POST',
      url: `/relationships/${target}/mute`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
      payload: {
        calls: true,
        messages: true,
      },
    });

    // Now unmute
    const res = await app.inject({
      method: 'DELETE',
      url: `/relationships/${target}/mute`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });
    expect(res.statusCode).toBe(204);

    const doc = await db.collection('relationships').findOne({
      fromUserId: userA,
      toUserId: target,
    });
    expect(doc!.muteCalls).toBe(false);
    expect(doc!.muteMessages).toBe(false);
    expect(doc!.muteUntil).toBeNull();
  });

  it('merge behavior: existing mute calls=true, POST { messages: true } → both become true', async () => {
    const target = crypto.randomUUID();

    // 1. Initial mute: calls only
    const res1 = await app.inject({
      method: 'POST',
      url: `/relationships/${target}/mute`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
      payload: {
        calls: true,
      },
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.json().calls).toBe(true);
    expect(res1.json().messages).toBe(false);

    // 2. Second mute: messages only
    const res2 = await app.inject({
      method: 'POST',
      url: `/relationships/${target}/mute`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
      payload: {
        messages: true,
      },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json();
    expect(body2.calls).toBe(true);
    expect(body2.messages).toBe(true);

    const doc = await db.collection('relationships').findOne({
      fromUserId: userA,
      toUserId: target,
    });
    expect(doc!.muteCalls).toBe(true);
    expect(doc!.muteMessages).toBe(true);
  });

  it('self-mute → 400 self_action_not_allowed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/relationships/${userA}/mute`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
      payload: {
        calls: true,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('self_action_not_allowed');
  });
});
