import type { Db } from 'mongodb';
import { getDb, getHashtagsCollection, getProfilesCollection } from '../../db/mongo.js';
import { SocialEventPublisher, defaultSocialEventPublisher } from './events.js';

export interface ParsedTokens {
  usernames: string[];
  hashtags: string[];
}

export interface ResolvedTokens {
  mentions: string[];
  hashtags: string[];
}

const MENTION_REGEX = /(?<![a-zA-Z0-9_.@])@([a-zA-Z][a-zA-Z0-9_.]{0,29})/g;
const HASHTAG_REGEX = /(?<![a-zA-Z0-9_])#([a-zA-Z0-9_]{1,50})/g;

/**
 * Extract unique lowercased `@username` and `#hashtag` tokens from a text body.
 */
export function parseBodyTokens(body: string): ParsedTokens {
  const usernames: string[] = [];
  const seenUsers = new Set<string>();
  const hashtags: string[] = [];
  const seenTags = new Set<string>();

  if (!body) {
    return { usernames, hashtags };
  }

  for (const match of body.matchAll(MENTION_REGEX)) {
    const cleaned = match[1]?.replace(/\.+$/, '').toLowerCase() ?? '';
    if (cleaned.length >= 2 && !seenUsers.has(cleaned)) {
      seenUsers.add(cleaned);
      usernames.push(cleaned);
    }
  }

  for (const match of body.matchAll(HASHTAG_REGEX)) {
    const cleaned = match[1]?.toLowerCase() ?? '';
    if (cleaned.length >= 1 && !seenTags.has(cleaned)) {
      seenTags.add(cleaned);
      hashtags.push(cleaned);
    }
  }

  return { usernames, hashtags };
}

/**
 * Resolve `@username` tokens against `profiles` (ignoring missing usernames),
 * persist newly discovered hashtags in `hashtags` collection, and emit
 * `core.user.mentioned` and `core.hashtag.created` events as needed.
 */
export async function resolveAndRecordTokens(params: {
  body: string;
  authorId: string;
  contentType: 'post' | 'comment' | 'reel';
  contentId?: string;
  contextPostId?: string;
  db?: Db;
  publisher?: SocialEventPublisher;
  previousMentions?: string[];
  emitEvents?: boolean;
}): Promise<ResolvedTokens> {
  const {
    body,
    authorId,
    contentType,
    contentId,
    contextPostId,
    db: customDb,
    publisher = defaultSocialEventPublisher,
    previousMentions = [],
    emitEvents = true,
  } = params;

  const { usernames, hashtags } = parseBodyTokens(body);
  const targetDb = customDb ?? getDb();

  let mentions: string[] = [];
  if (usernames.length > 0) {
    const profiles = await getProfilesCollection(targetDb)
      .find(
        { username: { $in: usernames } },
        { projection: { userId: 1, username: 1, isBanned: 1 } }
      )
      .toArray();

    const byUsername = new Map<string, string>();
    for (const p of profiles) {
      if (!p.isBanned && p.userId && p.username) {
        byUsername.set(p.username.toLowerCase(), p.userId);
      }
    }

    const seenIds = new Set<string>();
    for (const uname of usernames) {
      const uid = byUsername.get(uname);
      if (uid && !seenIds.has(uid)) {
        seenIds.add(uid);
        mentions.push(uid);
      }
    }
  }

  if (emitEvents && contentId) {
    await emitTokenEvents({
      mentions,
      hashtags,
      body,
      authorId,
      contentType,
      contentId,
      contextPostId: contextPostId ?? contentId,
      db: targetDb,
      publisher,
      previousMentions,
    });
  }

  return { mentions, hashtags };
}

/**
 * Emit mention and first-use hashtag events for already-saved content.
 */
export async function emitTokenEvents(params: {
  mentions: string[];
  hashtags: string[];
  body: string;
  authorId: string;
  contentType: 'post' | 'comment' | 'reel';
  contentId: string;
  contextPostId: string;
  db?: Db;
  publisher?: SocialEventPublisher;
  previousMentions?: string[];
}): Promise<void> {
  const {
    mentions,
    hashtags,
    body,
    authorId,
    contentType,
    contentId,
    contextPostId,
    db: customDb,
    publisher = defaultSocialEventPublisher,
    previousMentions = [],
  } = params;

  const targetDb = customDb ?? getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const prevSet = new Set(previousMentions);

  for (const mentionedUserId of mentions) {
    if (mentionedUserId === authorId || prevSet.has(mentionedUserId)) {
      continue;
    }
    await publisher.publishUserMentioned({
      userId: mentionedUserId,
      byUserId: authorId,
      contentType,
      contentId,
      context: body.slice(0, 140),
      at: nowIso,
    });
  }

  if (hashtags.length > 0) {
    const hashtagsCol = getHashtagsCollection(targetDb);
    for (const tag of hashtags) {
      try {
        const res = await hashtagsCol.updateOne(
          { _id: tag },
          {
            $setOnInsert: {
              _id: tag,
              tag,
              firstPostId: contextPostId,
              createdAt: now,
            },
          },
          { upsert: true }
        );
        if ((res.upsertedCount ?? 0) > 0) {
          await publisher.publishHashtagCreated({
            tag,
            postId: contextPostId,
            at: nowIso,
          });
        }
      } catch {
        // Non-blocking on duplicate race during concurrent first use
      }
    }
  }
}
