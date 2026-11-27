import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import type { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import * as mongoDb from '../../src/db/mongo.js';
import { getRedisClient } from '../../src/db/redis.js';
import { jwksService } from '../../src/auth/jwks.js';
import { getOrCreateTestAuthKeys, createMockAccessToken } from '../mocks/jwt.mock.js';

describe('Social - V4-2 Advanced Comments, Mentions & Hashtags', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;
  let redis: Redis;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const userC = crypto.randomUUID();

  let tokenA: string;
  let tokenB: string;
  let tokenC: string;

  async function clearRateLimits() {
    if (!redis) return;
    for (const uid of [userA, userB, userC]) {
      const keys = await redis.keys(`ratelimit:*:${uid}:*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    }
  }

  async function createPost(token: string, body: string): Promise<any> {
    const res = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { authorization: `Bearer ${token}` },
      payload: { body },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function createComment(
    token: string,
    postId: string,
    body: string,
    parentCommentId?: string
  ): Promise<any> {
    const res = await app.inject({
      method: 'POST',
      url: `/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${token}` },
      payload: parentCommentId ? { body, parentCommentId } : { body },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  beforeAll(async () => {
    await mongoDb.closeMongo();
    dbName = `test_social_v4_2_${crypto.randomUUID().replace(/-/g, '')}`;
    const conn = await mongoDb.connectMongo(`mongodb://localhost:27017/${dbName}`);
    client = conn.client;
    db = conn.db;

    redis = getRedisClient();
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    tokenA = await createMockAccessToken({ sub: userA, email: 'v42a@nebron.io' });
    tokenB = await createMockAccessToken({ sub: userB, email: 'v42b@nebron.io' });
    tokenC = await createMockAccessToken({ sub: userC, email: 'v42c@nebron.io' });

    const now = new Date();
    await db.collection('profiles').insertMany([
      {
        userId: userA,
        username: 'alice.v42',
        name: 'Alice',
        language: 'en',
        theme: 'dark',
        avatarKey: null,
        bannerKey: null,
        followerCount: 0,
        followingCount: 0,
        postCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        userId: userB,
        username: 'bob_v42',
        name: 'Bob',
        language: 'en',
        theme: 'dark',
        avatarKey: null,
        bannerKey: null,
        followerCount: 0,
        followingCount: 0,
        postCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        userId: userC,
        username: 'charlie_v42',
        name: 'Charlie',
        language: 'en',
        theme: 'dark',
        avatarKey: null,
        bannerKey: null,
        followerCount: 0,
        followingCount: 0,
        postCount: 0,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    app = await buildApp();
  });

  beforeEach(async () => {
    await clearRateLimits();
  });

  afterAll(async () => {
    await clearRateLimits();
    if (redis) {
      await redis.del(`rel:blocked:${userA}`, `rel:blocked:${userB}`, `rel:blocked:${userC}`);
    }
    if (app) await app.close();
    if (client) {
      await db.dropDatabase();
      await mongoDb.closeMongo();
    }
  });

  it('1. Edit own comment sets editedAt, updates body, and publishes core.comment.updated', async () => {
    const post = await createPost(tokenA, 'Post for edit test');
    const comment = await createComment(tokenB, post.id, 'Original comment body');
    expect(comment.editedAt).toBeNull();

    const editRes = await app.inject({
      method: 'PATCH',
      url: `/comments/${comment.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: 'Edited comment body!' },
    });

    expect(editRes.statusCode).toBe(200);
    const updated = editRes.json();
    expect(updated.body).toBe('Edited comment body!');
    expect(updated.editedAt).toBeTruthy();

    const streamEntries = await redis.xrevrange('nebron.events', '+', '-', 'COUNT', 20);
    const found = streamEntries.find(([, fields]) => {
      const idxType = fields.indexOf('type');
      const idxPayload = fields.indexOf('payload');
      if (idxType === -1 || idxPayload === -1) return false;
      if (fields[idxType + 1] !== 'core.comment.updated') return false;
      const parsed = JSON.parse(fields[idxPayload + 1]);
      return parsed.commentId === comment.id && parsed.body === 'Edited comment body!';
    });
    expect(found).toBeTruthy();
  });

  it("2. Edit another user's comment returns 403 not_comment_author", async () => {
    const post = await createPost(tokenA, 'Post for 403 edit test');
    const comment = await createComment(tokenB, post.id, 'Bobs comment');

    const res = await app.inject({
      method: 'PATCH',
      url: `/comments/${comment.id}`,
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { body: 'Charlie trying to hijack' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_comment_author');
  });

  it('3. Edit deleted comment returns 400 deleted', async () => {
    const post = await createPost(tokenA, 'Post for deleted edit test');
    const comment = await createComment(tokenB, post.id, 'Soon deleted');

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/comments/${comment.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(delRes.statusCode).toBe(204);

    const editRes = await app.inject({
      method: 'PATCH',
      url: `/comments/${comment.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: 'Trying to resurrect' },
    });
    expect(editRes.statusCode).toBe(400);
    expect(editRes.json().error.code).toBe('deleted');
  });

  it('4. Pin comment puts it first in list and sets pinned + pinnedAt', async () => {
    const post = await createPost(tokenA, 'Post for pin order');
    const c1 = await createComment(tokenB, post.id, 'Most liked unpinned comment');
    const c2 = await createComment(tokenC, post.id, 'Comment to pin');

    // Like c1 twice so it has higher likeCount than c2
    await app.inject({
      method: 'POST',
      url: `/comments/${c1.id}/like`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    await app.inject({
      method: 'POST',
      url: `/comments/${c1.id}/like`,
      headers: { authorization: `Bearer ${tokenC}` },
    });

    const pinRes = await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/comments/${c2.id}/pin`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(pinRes.statusCode).toBe(204);

    const listRes = await app.inject({
      method: 'GET',
      url: `/posts/${post.id}/comments?sort=top`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(listRes.statusCode).toBe(200);
    const items = listRes.json();
    expect(items[0].id).toBe(c2.id);
    expect(items[0].pinned).toBe(true);
    expect(items[0].pinnedAt).toBeTruthy();
    expect(items[1].id).toBe(c1.id);
    expect(items[1].pinned).toBe(false);
  });

  it('5. Unpin comment returns it to normal sort order', async () => {
    const post = await createPost(tokenA, 'Post for unpin test');
    const c1 = await createComment(tokenB, post.id, 'High likes');
    const c2 = await createComment(tokenC, post.id, 'Low likes pinned then unpinned');

    await app.inject({
      method: 'POST',
      url: `/comments/${c1.id}/like`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/comments/${c2.id}/pin`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    let list = (
      await app.inject({
        method: 'GET',
        url: `/posts/${post.id}/comments?sort=top`,
        headers: { authorization: `Bearer ${tokenA}` },
      })
    ).json();
    expect(list[0].id).toBe(c2.id);

    const unpinRes = await app.inject({
      method: 'DELETE',
      url: `/posts/${post.id}/comments/${c2.id}/pin`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(unpinRes.statusCode).toBe(204);

    list = (
      await app.inject({
        method: 'GET',
        url: `/posts/${post.id}/comments?sort=top`,
        headers: { authorization: `Bearer ${tokenA}` },
      })
    ).json();
    expect(list[0].id).toBe(c1.id);
    expect(list[1].id).toBe(c2.id);
    expect(list[1].pinned).toBe(false);
    expect(list[1].pinnedAt).toBeNull();
  });

  it('6. Pin 4th comment returns 400 max_pinned', async () => {
    const post = await createPost(tokenA, 'Post for max 3 pins');
    const c1 = await createComment(tokenB, post.id, 'Pin 1');
    const c2 = await createComment(tokenB, post.id, 'Pin 2');
    const c3 = await createComment(tokenB, post.id, 'Pin 3');
    const c4 = await createComment(tokenB, post.id, 'Pin 4 overflow');

    for (const c of [c1, c2, c3]) {
      const r = await app.inject({
        method: 'POST',
        url: `/posts/${post.id}/comments/${c.id}/pin`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(r.statusCode).toBe(204);
    }

    // Re-pinning an already pinned comment stays idempotent
    const repeatRes = await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/comments/${c1.id}/pin`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(repeatRes.statusCode).toBe(204);

    const res4 = await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/comments/${c4.id}/pin`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res4.statusCode).toBe(400);
    expect(res4.json().error.code).toBe('max_pinned');
  });

  it('7. Non-post-author attempting to pin or unpin returns 403 not_post_author', async () => {
    const post = await createPost(tokenA, 'Owned by Alice');
    const c1 = await createComment(tokenB, post.id, 'By Bob');

    const pinRes = await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/comments/${c1.id}/pin`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(pinRes.statusCode).toBe(403);
    expect(pinRes.json().error.code).toBe('not_post_author');

    await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/comments/${c1.id}/pin`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    const unpinRes = await app.inject({
      method: 'DELETE',
      url: `/posts/${post.id}/comments/${c1.id}/pin`,
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(unpinRes.statusCode).toBe(403);
    expect(unpinRes.json().error.code).toBe('not_post_author');
  });

  it('8. Mention parsing resolves @username to userIds on posts and comments', async () => {
    const post = await createPost(tokenA, 'Shoutout to @bob_v42 today!');
    expect(post.mentions).toEqual([userB]);

    const comment = await createComment(tokenB, post.id, 'Thanks @alice.v42!');
    expect(comment.mentions).toEqual([userA]);

    const streamEntries = await redis.xrevrange('nebron.events', '+', '-', 'COUNT', 25);
    const mentionEvent = streamEntries.find(([, fields]) => {
      const t = fields[fields.indexOf('type') + 1];
      if (t !== 'core.user.mentioned') return false;
      const p = JSON.parse(fields[fields.indexOf('payload') + 1]);
      return p.contentId === comment.id && p.userId === userA && p.byUserId === userB;
    });
    expect(mentionEvent).toBeTruthy();
  });

  it('9. Invalid @mention (no such user) is ignored without error', async () => {
    const post = await createPost(tokenA, 'Hello @does_not_exist_99 and email test@example.com');
    expect(post.mentions).toEqual([]);

    const comment = await createComment(tokenB, post.id, 'Hi @ghost_user!');
    expect(comment.mentions).toEqual([]);
  });

  it('10. Hashtag parsing lowercases tags and emits core.hashtag.created on first use', async () => {
    const uniqTag = `NebronLaunch_${Date.now()}`;
    const post = await createPost(tokenA, `Check out #${uniqTag} now!`);
    expect(post.hashtags).toEqual([uniqTag.toLowerCase()]);

    const doc = await db.collection('hashtags').findOne({ _id: uniqTag.toLowerCase() as any });
    expect(doc).toBeTruthy();

    const streamEntries = await redis.xrevrange('nebron.events', '+', '-', 'COUNT', 20);
    const createdEvents = streamEntries.filter(([, fields]) => {
      const t = fields[fields.indexOf('type') + 1];
      if (t !== 'core.hashtag.created') return false;
      const p = JSON.parse(fields[fields.indexOf('payload') + 1]);
      return p.tag === uniqTag.toLowerCase();
    });
    expect(createdEvents.length).toBe(1);

    // Second post with same tag (different case) does not emit duplicate core.hashtag.created
    await createPost(tokenB, `Second post with #${uniqTag.toUpperCase()}`);
    const streamAfter = await redis.xrevrange('nebron.events', '+', '-', 'COUNT', 20);
    const createdEventsAfter = streamAfter.filter(([, fields]) => {
      const t = fields[fields.indexOf('type') + 1];
      if (t !== 'core.hashtag.created') return false;
      const p = JSON.parse(fields[fields.indexOf('payload') + 1]);
      return p.tag === uniqTag.toLowerCase();
    });
    expect(createdEventsAfter.length).toBe(1);
  });

  it('11. Multiple mentions and hashtags are stored and deduplicated', async () => {
    const post = await createPost(
      tokenA,
      'With @bob_v42, @charlie_v42 and @bob_v42 covering #Alpha #Beta #alpha'
    );
    expect(post.mentions).toEqual([userB, userC]);
    expect(post.hashtags).toEqual(['alpha', 'beta']);

    const comment = await createComment(
      tokenC,
      post.id,
      'Reply @alice.v42 @bob_v42 #Gamma #gamma #Delta'
    );
    expect(comment.mentions).toEqual([userA, userB]);
    expect(comment.hashtags).toEqual(['gamma', 'delta']);
  });

  it('12. GET /hashtags/:tag/posts returns matching posts DESC by createdAt with enrichments', async () => {
    const tag = `search_${Date.now()}`;
    const p1 = await createPost(tokenA, `First #${tag} post`);
    const p2 = await createPost(tokenB, `Second #${tag.toUpperCase()} post`);

    await app.inject({
      method: 'POST',
      url: `/posts/${p2.id}/like`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    await createComment(tokenA, p2.id, 'Nice post!');

    const res = await app.inject({
      method: 'GET',
      url: `/hashtags/${tag}/posts?limit=10`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload.tag).toBe(tag.toLowerCase());
    expect(payload.postCount).toBe(2);
    expect(payload.hasMore).toBe(false);
    expect(payload.data.length).toBe(2);
    expect(payload.data[0].id).toBe(p2.id);
    expect(payload.data[0].likeCount).toBe(1);
    expect(payload.data[0].likedByViewer).toBe(true);
    expect(payload.data[0].commentCount).toBe(1);
    expect(payload.data[0].author.username).toBe('bob_v42');
    expect(payload.data[1].id).toBe(p1.id);
  });

  it('13. GET /hashtags/trending returns top hashtags in last 7 days sorted by postCount', async () => {
    const prefix = `trend_${Date.now()}`;
    const hotTag = `${prefix}_hot`;
    const warmTag = `${prefix}_warm`;
    const oldTag = `${prefix}_old`;

    await createPost(tokenA, `#${hotTag} #${warmTag}`);
    await createPost(tokenB, `#${hotTag} #${warmTag}`);
    await createPost(tokenC, `#${hotTag}`);

    // Insert an old post (> 7 days ago) directly to verify 7-day window
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await db.collection('posts').insertMany([
      {
        authorId: userA,
        body: `Old 1 #${oldTag}`,
        imageKey: null,
        imageUrl: null,
        mentions: [],
        hashtags: [oldTag],
        likeCount: 0,
        commentCount: 0,
        deleted: false,
        createdAt: eightDaysAgo,
        updatedAt: eightDaysAgo,
      },
      {
        authorId: userA,
        body: `Old 2 #${oldTag}`,
        imageKey: null,
        imageUrl: null,
        mentions: [],
        hashtags: [oldTag],
        likeCount: 0,
        commentCount: 0,
        deleted: false,
        createdAt: eightDaysAgo,
        updatedAt: eightDaysAgo,
      },
      {
        authorId: userA,
        body: `Old 3 #${oldTag}`,
        imageKey: null,
        imageUrl: null,
        mentions: [],
        hashtags: [oldTag],
        likeCount: 0,
        commentCount: 0,
        deleted: false,
        createdAt: eightDaysAgo,
        updatedAt: eightDaysAgo,
      },
      {
        authorId: userA,
        body: `Old 4 #${oldTag}`,
        imageKey: null,
        imageUrl: null,
        mentions: [],
        hashtags: [oldTag],
        likeCount: 0,
        commentCount: 0,
        deleted: false,
        createdAt: eightDaysAgo,
        updatedAt: eightDaysAgo,
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/hashtags/trending?limit=20',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json();
    const hotItem = items.find((i: any) => i.tag === hotTag);
    const warmItem = items.find((i: any) => i.tag === warmTag);
    const oldItem = items.find((i: any) => i.tag === oldTag);
    expect(hotItem?.postCount).toBe(3);
    expect(warmItem?.postCount).toBe(2);
    expect(oldItem).toBeUndefined();

    const hotIdx = items.findIndex((i: any) => i.tag === hotTag);
    const warmIdx = items.findIndex((i: any) => i.tag === warmTag);
    expect(hotIdx).toBeLessThan(warmIdx);
  });

  it('14. Hashtag feed excludes deleted posts', async () => {
    const tag = `deltag_${Date.now()}`;
    const pKeep = await createPost(tokenA, `Keep #${tag}`);
    const pDelete = await createPost(tokenA, `Delete #${tag}`);

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/posts/${pDelete.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(delRes.statusCode).toBe(204);

    const res = await app.inject({
      method: 'GET',
      url: `/hashtags/${tag}/posts`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload.postCount).toBe(1);
    expect(payload.data.map((p: any) => p.id)).toEqual([pKeep.id]);
  });

  it('15. Block filter excludes blocked user posts from hashtag feed and trending', async () => {
    const tag = `blocktag_${Date.now()}`;
    const pAlice = await createPost(tokenA, `Alice post #${tag}`);
    const pCharlie = await createPost(tokenC, `Charlie post #${tag}`);

    // Alice blocks Charlie
    await db.collection('relationships').insertOne({
      fromUserId: userA,
      toUserId: userC,
      blocked: true,
      muted: { messages: false, calls: false, until: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await redis.del(`rel:blocked:${userA}`, `rel:blocked:${userC}`);

    const resAlice = await app.inject({
      method: 'GET',
      url: `/hashtags/${tag}/posts`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(resAlice.statusCode).toBe(200);
    const bodyAlice = resAlice.json();
    expect(bodyAlice.postCount).toBe(1);
    expect(bodyAlice.data.map((p: any) => p.id)).toEqual([pAlice.id]);

    // Blocked user Charlie also cannot see Alice's posts
    const resCharlie = await app.inject({
      method: 'GET',
      url: `/hashtags/${tag}/posts`,
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(resCharlie.json().data.map((p: any) => p.id)).toEqual([pCharlie.id]);

    // Clean up relationship for remaining tests
    await db.collection('relationships').deleteMany({ fromUserId: userA, toUserId: userC });
    await redis.del(`rel:blocked:${userA}`, `rel:blocked:${userC}`);
  });

  it('16. Mention and hashtag work in reply-to-reply comments with two-level flattening', async () => {
    const post = await createPost(tokenA, 'Thread root post');
    const rootComment = await createComment(tokenA, post.id, 'Root comment');
    const firstReply = await createComment(tokenB, post.id, 'Bob reply', rootComment.id);
    const secondReply = await createComment(
      tokenC,
      post.id,
      'Hey @bob_v42 and @alice.v42 see #DeepReply',
      firstReply.id
    );

    expect(secondReply.parentCommentId).toBe(rootComment.id);
    expect(secondReply.replyToUser).toEqual({
      userId: userB,
      username: 'bob_v42',
    });
    expect(secondReply.mentions).toEqual([userB, userA]);
    expect(secondReply.hashtags).toEqual(['deepreply']);
  });

  it('17. Edit updates mentions and hashtags arrays on comments and posts', async () => {
    const oldTag = `oldtag_${Date.now()}`;
    const newTag = `newtag_${Date.now()}`;

    const post = await createPost(tokenA, `Post with @bob_v42 and #${oldTag}`);
    const comment = await createComment(tokenB, post.id, `Comment with @alice.v42 #${oldTag}`);

    const editedCommentRes = await app.inject({
      method: 'PATCH',
      url: `/comments/${comment.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: `Updated @charlie_v42 #${newTag}` },
    });
    expect(editedCommentRes.statusCode).toBe(200);
    const editedComment = editedCommentRes.json();
    expect(editedComment.mentions).toEqual([userC]);
    expect(editedComment.hashtags).toEqual([newTag]);

    const editedPostRes = await app.inject({
      method: 'PATCH',
      url: `/posts/${post.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: `Updated post @charlie_v42 #${newTag}` },
    });
    expect(editedPostRes.statusCode).toBe(200);
    const editedPost = editedPostRes.json();
    expect(editedPost.mentions).toEqual([userC]);
    expect(editedPost.hashtags).toEqual([newTag]);

    const oldTagFeed = await app.inject({
      method: 'GET',
      url: `/hashtags/${oldTag}/posts`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(oldTagFeed.json().data).toEqual([]);

    const newTagFeed = await app.inject({
      method: 'GET',
      url: `/hashtags/${newTag}/posts`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(newTagFeed.json().data.map((p: any) => p.id)).toEqual([post.id]);
  });

  it('18. Sort controls (top and new) preserve pinned comments at top', async () => {
    const post = await createPost(tokenA, 'Sort + pin post');
    const cOld = await createComment(tokenB, post.id, 'Oldest comment');
    await new Promise((r) => setTimeout(r, 15));
    const cLiked = await createComment(tokenB, post.id, 'Most liked comment');
    await app.inject({
      method: 'POST',
      url: `/comments/${cLiked.id}/like`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    await new Promise((r) => setTimeout(r, 15));
    const cNewest = await createComment(tokenC, post.id, 'Newest comment');

    // Pin cOld (oldest AND 0 likes)
    const pinRes = await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/comments/${cOld.id}/pin`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(pinRes.statusCode).toBe(204);

    const topRes = await app.inject({
      method: 'GET',
      url: `/posts/${post.id}/comments?sort=top`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(topRes.json().map((c: any) => c.id)).toEqual([cOld.id, cLiked.id, cNewest.id]);

    const newRes = await app.inject({
      method: 'GET',
      url: `/posts/${post.id}/comments?sort=new`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(newRes.json().map((c: any) => c.id)).toEqual([cOld.id, cNewest.id, cLiked.id]);
  });

  it('19. V4-2 migration entry recorded in migrations collection and defaults missing fields', async () => {
    const migration = await db.collection('migrations').findOne({
      _id: 'v4_2_comments_posts_advanced' as any,
    });
    expect(migration).toBeTruthy();

    const post = await createPost(tokenA, 'Post for legacy comment check');
    await db.collection('comments').insertOne({
      postId: new ObjectId(post.id),
      authorId: userB,
      body: 'Legacy pre-v4-2 comment',
      deleted: false,
      createdAt: new Date(),
    });

    const list = (
      await app.inject({
        method: 'GET',
        url: `/posts/${post.id}/comments`,
        headers: { authorization: `Bearer ${tokenA}` },
      })
    ).json();
    expect(list[0].pinned).toBe(false);
    expect(list[0].pinnedAt).toBeNull();
    expect(list[0].editedAt).toBeNull();
    expect(list[0].mentions).toEqual([]);
    expect(list[0].hashtags).toEqual([]);
  });

  it('20. Reel comments support token resolution and editing', async () => {
    const reelId = new ObjectId();
    await db.collection('reels').insertOne({
      _id: reelId,
      authorId: userA,
      videoKey: `reels/${userA}/clip.mp4`,
      videoUrl: 'https://cdn.example.com/clip.mp4',
      thumbnailKey: null,
      thumbnailUrl: null,
      caption: 'Reel caption',
      duration: 12,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      deleted: false,
      r2DeletedAt: null,
      createdAt: new Date(),
    });

    const createRes = await app.inject({
      method: 'POST',
      url: `/reels/${reelId.toString()}/comments`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: 'Cool reel @alice.v42 #ReelsRock' },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.mentions).toEqual([userA]);
    expect(created.hashtags).toEqual(['reelsrock']);

    const editRes = await app.inject({
      method: 'PATCH',
      url: `/comments/${created.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: 'Updated reel comment @charlie_v42 #NextTag' },
    });
    expect(editRes.statusCode).toBe(200);
    const edited = editRes.json();
    expect(edited.mentions).toEqual([userC]);
    expect(edited.hashtags).toEqual(['nexttag']);
    expect(edited.editedAt).toBeTruthy();
  });
});
