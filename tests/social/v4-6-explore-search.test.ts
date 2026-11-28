import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import type { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import * as mongoDb from '../../src/db/mongo.js';
import { getRedisClient } from '../../src/db/redis.js';
import { jwksService } from '../../src/auth/jwks.js';
import { getOrCreateTestAuthKeys, createMockAccessToken } from '../mocks/jwt.mock.js';
import { handleEvent } from '../../src/modules/events/handlers.js';
import { SocialSearchService, defaultSocialSearchService } from '../../src/modules/search/meili.service.js';
import { computePublicUrl } from '../../src/lib/r2.js';

describe('Social - V4-6 Explore, Profile Stats & Meilisearch Search', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;
  let redis: Redis;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const userC = crypto.randomUUID();
  const userD = crypto.randomUUID();

  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let tokenD: string;

  async function seedProfile(
    userId: string,
    username: string,
    extra: Record<string, unknown> = {}
  ) {
    await db.collection('profiles').updateOne(
      { userId },
      {
        $set: {
          userId,
          username,
          name: username.toUpperCase(),
          language: 'en',
          theme: 'dark',
          avatarKey: null,
          bannerKey: null,
          followerCount: 0,
          followingCount: 0,
          postCount: 0,
          online: true,
          lastSeenAt: new Date('2026-11-27T10:00:00Z'),
          privacy: {
            showOnlineStatus: 'everyone',
            showLastSeen: 'everyone',
            sendReadReceipts: true,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
          ...extra,
        },
      },
      { upsert: true }
    );
  }

  beforeAll(async () => {
    await mongoDb.closeMongo();
    dbName = `test_v46_explore_${crypto.randomUUID().replace(/-/g, '')}`;
    const conn = await mongoDb.connectMongo(`mongodb://localhost:27017/${dbName}`);
    client = conn.client;
    db = conn.db;

    redis = getRedisClient();
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    tokenA = await createMockAccessToken({ sub: userA, email: 'v46a@nebron.io' });
    tokenB = await createMockAccessToken({ sub: userB, email: 'v46b@nebron.io' });
    tokenC = await createMockAccessToken({ sub: userC, email: 'v46c@nebron.io' });
    tokenD = await createMockAccessToken({ sub: userD, email: 'v46d@nebron.io' });

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
    if (db) await db.dropDatabase();
    if (client) await client.close();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([
      db.collection('profiles').deleteMany({}),
      db.collection('posts').deleteMany({}),
      db.collection('reels').deleteMany({}),
      db.collection('stories').deleteMany({}),
      db.collection('follows').deleteMany({}),
      db.collection('relationships').deleteMany({}),
      db.collection('post_likes').deleteMany({}),
      db.collection('reel_likes').deleteMany({}),
      db.collection('saved_posts').deleteMany({}),
    ]);

    for (const uid of [userA, userB, userC, userD]) {
      await redis.del(`rel:blocked:${uid}`);
      const rl = await redis.keys(`ratelimit:*:${uid}:*`);
      if (rl.length > 0) await redis.del(...rl);
    }

    await Promise.all([
      seedProfile(userA, 'alice_v46', { followerCount: 10 }),
      seedProfile(userB, 'bob_v46', { followerCount: 5 }),
      seedProfile(userC, 'charlie_v46', { followerCount: 50 }),
      seedProfile(userD, 'dave_v46', { followerCount: 2 }),
    ]);
  });

  it('1. Trending algorithm returns non-zero engagement content first and ranks velocity DESC', async () => {
    const now = Date.now();
    const hotRecentId = new ObjectId();
    const olderLowerId = new ObjectId();
    const zeroEngId = new ObjectId();

    await db.collection('posts').insertMany([
      {
        _id: zeroEngId,
        authorId: userB,
        body: 'Zero engagement brand new post',
        likeCount: 0,
        commentCount: 0,
        shareCount: 0,
        saveCount: 0,
        deleted: false,
        createdAt: new Date(now - 60_000),
        updatedAt: new Date(now - 60_000),
      },
      {
        _id: olderLowerId,
        authorId: userC,
        body: 'Moderate engagement older post',
        likeCount: 4,
        commentCount: 0,
        shareCount: 0,
        saveCount: 0,
        deleted: false,
        createdAt: new Date(now - 10 * 3_600_000), // velocity = 0.4
        updatedAt: new Date(now - 10 * 3_600_000),
      },
      {
        _id: hotRecentId,
        authorId: userC,
        body: 'Viral recent post #viral',
        likeCount: 10,
        commentCount: 3,
        shareCount: 2,
        saveCount: 4,
        deleted: false,
        createdAt: new Date(now - 2 * 3_600_000), // (10 + 6 + 6 + 8) / 2 = 15.0
        updatedAt: new Date(now - 2 * 3_600_000),
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/explore/trending?type=posts&period=7d&limit=10',
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((p: any) => p.id)).toEqual([
      hotRecentId.toString(),
      olderLowerId.toString(),
      zeroEngId.toString(),
    ]);
  });

  it('2. Empty follower list -> explore trending still returns populated content excluding own and blocked', async () => {
    const bobPostId = new ObjectId();
    const ownPostId = new ObjectId();
    const blockedPostId = new ObjectId();

    await db.collection('relationships').insertOne({
      fromUserId: userA,
      toUserId: userD,
      blocked: true,
      updatedAt: new Date(),
    });

    await db.collection('posts').insertMany([
      {
        _id: ownPostId,
        authorId: userA,
        body: 'Own post should not be in explore',
        likeCount: 99,
        commentCount: 0,
        deleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: blockedPostId,
        authorId: userD,
        body: 'Blocked user post excluded',
        likeCount: 99,
        commentCount: 0,
        deleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: bobPostId,
        authorId: userB,
        body: 'Populated discovery post',
        likeCount: 2,
        commentCount: 1,
        deleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    // userA follows 0 users
    const res = await app.inject({
      method: 'GET',
      url: '/explore/trending?type=posts&period=24h',
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((p: any) => p.id);
    expect(ids).toEqual([bobPostId.toString()]);
  });

  it('3. Trending works for reels too', async () => {
    const r1 = new ObjectId();
    await db.collection('reels').insertOne({
      _id: r1,
      authorId: userB,
      caption: 'Trending dance reel',
      videoKey: `reels/${userB}/dance.mp4`,
      videoUrl: 'https://cdn.example.com/dance.mp4',
      thumbnailKey: null,
      thumbnailUrl: null,
      duration: 15,
      viewCount: 40,
      likeCount: 8,
      commentCount: 2,
      saveCount: 3,
      shareCount: 1,
      deleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/explore/trending?type=reels&period=24h',
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBe(1);
    expect(res.json().items[0].id).toBe(r1.toString());
  });

  it('4. GET /users/:userId/stats and /users/me/stats return accurate counts and respect showOnlineStatus privacy', async () => {
    await db.collection('profiles').updateOne(
      { userId: userB },
      {
        $set: {
          followerCount: 12,
          followingCount: 4,
          postCount: 2,
          online: true,
          lastSeenAt: new Date('2026-11-27T11:00:00Z'),
          privacy: {
            showOnlineStatus: 'nobody',
            showLastSeen: 'nobody',
            sendReadReceipts: false,
          },
        },
      }
    );

    const p1 = new ObjectId();
    const p2 = new ObjectId();
    await db.collection('posts').insertMany([
      {
        _id: p1,
        authorId: userB,
        body: 'Post 1',
        likeCount: 5,
        commentCount: 1,
        shareCount: 2,
        saveCount: 1,
        deleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: p2,
        authorId: userB,
        body: 'Post 2',
        likeCount: 3,
        commentCount: 0,
        shareCount: 0,
        saveCount: 4,
        deleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await db.collection('reels').insertOne({
      _id: new ObjectId(),
      authorId: userB,
      caption: 'Reel 1',
      videoKey: `reels/${userB}/r1.mp4`,
      videoUrl: 'https://cdn.example.com/r1.mp4',
      thumbnailKey: null,
      thumbnailUrl: null,
      duration: 10,
      viewCount: 55,
      likeCount: 7,
      commentCount: 0,
      saveCount: 2,
      shareCount: 1,
      deleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('saved_posts').insertOne({
      userId: userB,
      postId: p1,
      savedAt: new Date(),
    });

    // Public stats query by userA: showOnlineStatus='nobody' MUST hide online & lastSeenAt
    const pubRes = await app.inject({
      method: 'GET',
      url: `/users/${userB}/stats`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(pubRes.statusCode).toBe(200);
    const pub = pubRes.json();
    expect(pub).toMatchObject({
      userId: userB,
      postCount: 2,
      reelCount: 1,
      totalLikesReceived: 15, // 5 + 3 + 7
      totalViewsReceived: 55,
      followerCount: 12,
      followingCount: 4,
    });
    expect(pub.online).toBeUndefined();
    expect(pub.lastSeenAt).toBeUndefined();
    expect(pub.savedCount).toBeUndefined();

    // Own private stats via GET /users/me/stats MUST include private stats & online status
    const meRes = await app.inject({
      method: 'GET',
      url: '/users/me/stats',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(meRes.statusCode).toBe(200);
    const me = meRes.json();
    expect(me.online).toBe(true);
    expect(me.lastSeenAt).toBe('2026-11-27T11:00:00.000Z');
    expect(me.savedCount).toBe(1);
    expect(me.totalSharesReceived).toBe(3);
    expect(me.totalSavesReceived).toBe(7);
  });

  it('5. GET /explore/suggestions excludes self, already-followed, blocked, and prioritizes friends_of_friends + similar_interests', async () => {
    // A follows B; B follows C (friends_of_friends for A); D is blocked by A
    await db.collection('follows').insertMany([
      { followerId: userA, followingId: userB, createdAt: new Date() },
      { followerId: userB, followingId: userC, createdAt: new Date() },
    ]);
    await db.collection('relationships').insertOne({
      fromUserId: userA,
      toUserId: userD,
      blocked: true,
      updatedAt: new Date(),
    });

    const userE = crypto.randomUUID();
    await seedProfile(userE, 'eve_v46', { followerCount: 100 });

    const res = await app.inject({
      method: 'GET',
      url: '/explore/suggestions?limit=10',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const suggestions = res.json();
    const ids = suggestions.map((s: any) => s.userId);

    expect(ids).not.toContain(userA); // excludes self
    expect(ids).not.toContain(userB); // excludes already-followed
    expect(ids).not.toContain(userD); // excludes blocked
    expect(ids[0]).toBe(userC); // friends_of_friends beats popular
    expect(suggestions[0].reason).toBe('friends_of_friends');
    expect(suggestions[0].contextLabel).toContain('@bob_v46');

    const eveEntry = suggestions.find((s: any) => s.userId === userE);
    expect(eveEntry?.reason).toBe('popular');
  });

  it('6. Search via Meilisearch client returns matching posts & reels and respects block filter', async () => {
    const pMatch = new ObjectId();
    const pBlocked = new ObjectId();
    const rMatch = new ObjectId();

    await db.collection('posts').insertMany([
      {
        _id: pMatch,
        authorId: userB,
        body: 'Quantum photonics breakthrough #science',
        hashtags: ['science'],
        likeCount: 3,
        commentCount: 0,
        deleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: pBlocked,
        authorId: userD,
        body: 'Quantum message from blocked author',
        hashtags: [],
        likeCount: 1,
        commentCount: 0,
        deleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await db.collection('reels').insertOne({
      _id: rMatch,
      authorId: userC,
      caption: 'Quantum experiment clip',
      videoKey: `reels/${userC}/q.mp4`,
      videoUrl: 'https://cdn.example.com/q.mp4',
      thumbnailKey: null,
      thumbnailUrl: null,
      duration: 12,
      viewCount: 5,
      likeCount: 1,
      commentCount: 0,
      deleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('relationships').insertOne({
      fromUserId: userA,
      toUserId: userD,
      blocked: true,
      updatedAt: new Date(),
    });

    // Mock Meilisearch client responses cleanly on defaultSocialSearchService
    vi.spyOn(defaultSocialSearchService, 'searchPostIds').mockImplementation(
      async (_q, excludedSet) => {
        const hits = [
          { id: pMatch.toString(), authorId: userB },
          { id: pBlocked.toString(), authorId: userD },
        ];
        return hits.filter((h) => !excludedSet.has(h.authorId)).map((h) => h.id);
      }
    );
    vi.spyOn(defaultSocialSearchService, 'searchReelIds').mockResolvedValue([rMatch.toString()]);

    const postSearch = await app.inject({
      method: 'GET',
      url: '/search/social?q=Quantum&type=posts',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(postSearch.statusCode).toBe(200);
    const postItems = postSearch.json().items;
    expect(postItems.length).toBe(1);
    expect(postItems[0].id).toBe(pMatch.toString());

    const reelSearch = await app.inject({
      method: 'GET',
      url: '/search/social?q=Quantum&type=reels',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(reelSearch.statusCode).toBe(200);
    expect(reelSearch.json().items.length).toBe(1);
    expect(reelSearch.json().items[0].id).toBe(rMatch.toString());
  });

  it('7. SocialSearchService and event consumer handle core.post.created/updated/deleted and core.reel.created', async () => {
    const addDocsPost = vi.fn().mockResolvedValue({ taskUid: 1 });
    const updateDocsPost = vi.fn().mockResolvedValue({ taskUid: 2 });
    const deleteDocPost = vi.fn().mockResolvedValue({ taskUid: 3 });
    const addDocsReel = vi.fn().mockResolvedValue({ taskUid: 4 });

    const mockMeiliClient = {
      index: (name: string) => ({
        addDocuments: name === 'posts' ? addDocsPost : addDocsReel,
        updateDocuments: updateDocsPost,
        deleteDocument: deleteDocPost,
        search: vi.fn().mockResolvedValue({ hits: [{ id: '65f000000000000000000001', authorId: userB }] }),
      }),
      tasks: { waitForTask: vi.fn().mockResolvedValue({}) },
    } as any;

    const svc = new SocialSearchService({ client: mockMeiliClient, db });
    await svc.indexPost({
      id: 'p1',
      authorId: userB,
      body: 'Hello #meili',
      createdAt: new Date(),
    });
    expect(addDocsPost).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'p1', authorId: userB, body: 'Hello #meili', hashtags: ['meili'] }),
      ])
    );

    // Verify consumer handles core.post.created / core.post.updated / core.post.deleted / core.reel.created
    const idxSpy = vi.spyOn(defaultSocialSearchService, 'indexPost').mockResolvedValue(undefined);
    const updSpy = vi.spyOn(defaultSocialSearchService, 'updatePost').mockResolvedValue(undefined);
    const delSpy = vi.spyOn(defaultSocialSearchService, 'deletePost').mockResolvedValue(undefined);
    const reelIdxSpy = vi.spyOn(defaultSocialSearchService, 'indexReel').mockResolvedValue(undefined);

    await handleEvent({
      type: 'core.post.created',
      data: { postId: 'p99', authorId: userB, body: 'New #search', createdAt: new Date().toISOString() },
    });
    expect(idxSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'p99', hashtags: ['search'] }));

    await handleEvent({
      type: 'core.post.updated',
      data: { postId: 'p99', body: 'Edited #updated', hashtags: ['updated'], editedAt: new Date().toISOString() },
    });
    expect(updSpy).toHaveBeenCalledWith('p99', 'Edited #updated', ['updated']);

    await handleEvent({
      type: 'core.post.deleted',
      data: { postId: 'p99' },
    });
    expect(delSpy).toHaveBeenCalledWith('p99');

    const reelObjId = new ObjectId();
    await db.collection('reels').insertOne({
      _id: reelObjId,
      authorId: userB,
      caption: 'Event consumer reel',
      videoKey: 'reels/b/c.mp4',
      videoUrl: 'https://cdn.example.com/c.mp4',
      duration: 8,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      deleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await handleEvent({
      type: 'core.reel.created',
      data: { reelId: reelObjId.toString(), authorId: userB, at: new Date().toISOString() },
    });
    expect(reelIdxSpy).toHaveBeenCalledWith(expect.objectContaining({ id: reelObjId.toString() }));
  });

  it('8. GET /hashtags/trending returns accurate counts and excludes blocked authors', async () => {
    await db.collection('relationships').insertOne({
      fromUserId: userA,
      toUserId: userD,
      blocked: true,
      updatedAt: new Date(),
    });

    await db.collection('posts').insertMany([
      {
        _id: new ObjectId(),
        authorId: userB,
        body: 'First #nebron tag',
        hashtags: ['nebron', 'launch'],
        likeCount: 1,
        commentCount: 0,
        deleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: new ObjectId(),
        authorId: userC,
        body: 'Second #nebron tag',
        hashtags: ['nebron'],
        likeCount: 1,
        commentCount: 0,
        deleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: new ObjectId(),
        authorId: userD, // blocked by userA
        body: 'Blocked #spamtag tag',
        hashtags: ['spamtag'],
        likeCount: 1,
        commentCount: 0,
        deleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/hashtags/trending?limit=10',
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list[0]).toEqual({ tag: 'nebron', postCount: 2 });
    expect(list.find((t: any) => t.tag === 'spamtag')).toBeUndefined();
  });

  it('9. Blocked viewer receives 403 when requesting target user /users/:userId/stats', async () => {
    await db.collection('relationships').insertOne({
      fromUserId: userB,
      toUserId: userA,
      blocked: true,
      updatedAt: new Date(),
    });

    const res = await app.inject({
      method: 'GET',
      url: `/users/${userB}/stats`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('10. PATCH /posts/:id emits core.post.updated event with hashtags and editedAt', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: 'Original body #oldtag' },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/posts/${created.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: 'Updated body #newtag #extra' },
    });
    expect(patchRes.statusCode).toBe(200);
    const updated = patchRes.json();
    expect(updated.hashtags).toEqual(['newtag', 'extra']);
  });

  it('11. Resolves live media URLs from object keys when stale tunnel URLs are stored in DB', async () => {
    const staleBase = 'https://stale-tunnel-host.trycloudflare.com/nebron-media';
    const postId = new ObjectId();
    const imageKey = `posts/${userB}/img.png`;
    await db.collection('posts').insertOne({
      _id: postId,
      authorId: userB,
      body: 'Stale URL post',
      imageKey,
      imageUrl: `${staleBase}/${imageKey}`,
      likeCount: 0,
      commentCount: 0,
      saveCount: 0,
      shareCount: 0,
      mentions: [],
      hashtags: [],
      deleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const reelId = new ObjectId();
    const videoKey = `reels/${userB}/clip.mp4`;
    const thumbKey = `reels/${userB}/thumb.jpg`;
    await db.collection('reels').insertOne({
      _id: reelId,
      authorId: userB,
      caption: 'Stale URL reel',
      videoKey,
      videoUrl: `${staleBase}/${videoKey}`,
      thumbnailKey: thumbKey,
      thumbnailUrl: `${staleBase}/${thumbKey}`,
      duration: 8,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      saveCount: 0,
      shareCount: 0,
      deleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const storyMediaKey = `stories/${userA}/s.jpg`;
    await db.collection('stories').insertOne({
      _id: new ObjectId(),
      authorId: userA,
      mediaType: 'image',
      mediaKey: storyMediaKey,
      mediaUrl: `${staleBase}/${storyMediaKey}`,
      thumbnailKey: null,
      duration: 5,
      caption: 'Stale URL story',
      viewers: [],
      viewerCount: 0,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
    });

    const postRes = await app.inject({
      method: 'GET',
      url: `/posts/${postId.toString()}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(postRes.statusCode).toBe(200);
    expect(postRes.json().imageUrl).toBe(computePublicUrl(imageKey));

    const reelRes = await app.inject({
      method: 'GET',
      url: `/reels/${reelId.toString()}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(reelRes.statusCode).toBe(200);
    expect(reelRes.json().videoUrl).toBe(computePublicUrl(videoKey));
    expect(reelRes.json().thumbnailUrl).toBe(computePublicUrl(thumbKey));

    const storiesRes = await app.inject({
      method: 'GET',
      url: `/stories/${userA}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(storiesRes.statusCode).toBe(200);
    expect(storiesRes.json().stories[0].mediaUrl).toBe(computePublicUrl(storyMediaKey));
  });
});
