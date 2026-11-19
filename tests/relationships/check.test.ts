import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';
import { buildApp } from '../../src/app.js';
import * as mongoDb from '../../src/db/mongo.js';
import { closeRedis } from '../../src/db/redis.js';
import { env } from '../../src/config/env.js';

describe('Relationships - Internal Batch Check Module', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;

  const userCaller = crypto.randomUUID();
  const userBlocked = crypto.randomUUID();
  const userMuted = crypto.randomUUID();
  const userUnknown = crypto.randomUUID();

  beforeAll(async () => {
    await mongoDb.closeMongo();
    dbName = `test_${crypto.randomUUID().replace(/-/g, '')}`;
    const mongoUrl = `mongodb://localhost:27017/${dbName}`;
    const conn = await mongoDb.connectMongo(mongoUrl);
    client = conn.client;
    db = conn.db;

    // Seed relationship data directly
    const now = new Date();
    await db.collection('relationships').insertMany([
      {
        fromUserId: userCaller,
        toUserId: userBlocked,
        blocked: true,
        muteCalls: false,
        muteMessages: false,
        muteUntil: null,
        updatedAt: now,
      },
      {
        fromUserId: userCaller,
        toUserId: userMuted,
        blocked: false,
        muteCalls: true,
        muteMessages: true,
        muteUntil: null,
        updatedAt: now,
      },
    ]);

    app = await buildApp();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.dropDatabase();
    await mongoDb.closeMongo();
    await closeRedis();
  });

  it('missing X-Internal-Token → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/relationships/check?userIds=${userBlocked}`,
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe('invalid_internal_token');
  });

  it('wrong token → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/relationships/check?userIds=${userBlocked}`,
      headers: {
        'x-internal-token': 'wrong-token-value',
      },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe('invalid_internal_token');
  });

  it('missing INTERNAL_TOKEN env → 503', async () => {
    const originalToken = env.INTERNAL_TOKEN;
    try {
      (env as any).INTERNAL_TOKEN = '';

      const res = await app.inject({
        method: 'GET',
        url: `/relationships/check?userIds=${userBlocked}`,
        headers: {
          'x-internal-token': originalToken,
        },
      });

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.error.code).toBe('internal_not_configured');
    } finally {
      (env as any).INTERNAL_TOKEN = originalToken;
    }
  });

  it('valid token, single userId → correct state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/relationships/check?fromUserId=${userCaller}&userIds=${userBlocked}`,
      headers: {
        'x-internal-token': env.INTERNAL_TOKEN,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, max-age=60');

    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.data[userBlocked]).toEqual({
      blocked: true,
      muted: {
        calls: false,
        messages: false,
      },
    });
  });

  it('valid token, multiple userIds → all returned', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/relationships/check?fromUserId=${userCaller}&userIds=${userBlocked},${userMuted}`,
      headers: {
        'x-internal-token': env.INTERNAL_TOKEN,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data[userBlocked]).toEqual({
      blocked: true,
      muted: {
        calls: false,
        messages: false,
      },
    });
    expect(body.data[userMuted]).toEqual({
      blocked: false,
      muted: {
        calls: true,
        messages: true,
      },
    });
  });

  it('unknown userIds → zero-state entries', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/relationships/check?fromUserId=${userCaller}&userIds=${userUnknown}`,
      headers: {
        'x-internal-token': env.INTERNAL_TOKEN,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data[userUnknown]).toEqual({
      blocked: false,
      muted: {
        calls: false,
        messages: false,
      },
    });
  });

  it('batch with one blocked and one muted returns correct mixed result', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/relationships/check?fromUserId=${userCaller}&userIds=${userBlocked},${userMuted},${userUnknown}`,
      headers: {
        'x-internal-token': env.INTERNAL_TOKEN,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual({
      [userBlocked]: {
        blocked: true,
        muted: {
          calls: false,
          messages: false,
        },
      },
      [userMuted]: {
        blocked: false,
        muted: {
          calls: true,
          messages: true,
        },
      },
      [userUnknown]: {
        blocked: false,
        muted: {
          calls: false,
          messages: false,
        },
      },
    });
  });
});
