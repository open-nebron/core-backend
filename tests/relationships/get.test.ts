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

describe('Relationships - GET Module', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;
  let redis: Redis;

  const userA = crypto.randomUUID();
  const userUnknown = crypto.randomUUID();
  const userBlocked = crypto.randomUUID();
  const userMuted = crypto.randomUUID();

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

  it('GET returns zero-state for unknown relationship (200, not 404)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/relationships/${userUnknown}`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      blocked: false,
      mute: {
        calls: false,
        messages: false,
        until: null,
      },
    });
  });

  it('GET after block returns blocked=true', async () => {
    // 1. Block user
    await app.inject({
      method: 'POST',
      url: `/relationships/${userBlocked}/block`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    // 2. Fetch relationship
    const res = await app.inject({
      method: 'GET',
      url: `/relationships/${userBlocked}`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.blocked).toBe(true);
    expect(body.mute).toEqual({
      calls: false,
      messages: false,
      until: null,
    });
  });

  it('GET after mute returns correct mute object', async () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString();

    // 1. Mute calls and messages with until date
    await app.inject({
      method: 'POST',
      url: `/relationships/${userMuted}/mute`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
      payload: {
        calls: true,
        messages: true,
        until: futureDate,
      },
    });

    // 2. Fetch relationship
    const res = await app.inject({
      method: 'GET',
      url: `/relationships/${userMuted}`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.blocked).toBe(false);
    expect(body.mute).toEqual({
      calls: true,
      messages: true,
      until: futureDate,
    });
  });

  it('rejects invalid userId with 400 invalid_uuid', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/relationships/invalid_user_id',
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_uuid');
  });
});
