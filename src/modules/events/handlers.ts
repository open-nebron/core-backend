import { ObjectId } from 'mongodb';
import { profileService } from '../profiles/profile.service.js';
import { getPostsCollection, getReelsCollection } from '../../db/mongo.js';
import { defaultSocialSearchService, extractSocialHashtags } from '../search/meili.service.js';
import type { UserRegisteredPayload, NebronEvent } from './types.js';

export async function handleEvent(event: NebronEvent): Promise<void> {
  switch (event.type) {
    case 'auth.user.registered': {
      const data = event.data as UserRegisteredPayload;
      if (!data || !data.userId || !data.email) {
        throw new Error(
          `Invalid payload for 'auth.user.registered': missing userId or email: ${JSON.stringify(event.data)}`
        );
      }
      console.log(`[EventConsumer] Processing 'auth.user.registered' for user ${data.userId} (${data.email})`);
      const profile = await profileService.createProfileFromEvent(data.userId, data.email);
      console.log(`[EventConsumer] Profile created/verified: username=${profile.username}, userId=${profile.userId}`);
      break;
    }

    case 'auth.session.revoked': {
      console.log(`[EventConsumer] Received 'auth.session.revoked':`, event.data);
      break;
    }

    case 'core.post.created': {
      const data = event.data as {
        postId?: string;
        authorId?: string;
        body?: string;
        hashtags?: string[];
        createdAt?: string;
      };
      if (data?.postId && data.authorId && data.body) {
        await defaultSocialSearchService.indexPost({
          id: data.postId,
          authorId: data.authorId,
          body: data.body,
          hashtags: data.hashtags ?? extractSocialHashtags(data.body),
          createdAt: data.createdAt ?? new Date(),
        });
      }
      break;
    }

    case 'core.post.updated': {
      const data = event.data as {
        postId?: string;
        body?: string;
        hashtags?: string[];
      };
      if (data?.postId && typeof data.body === 'string') {
        await defaultSocialSearchService.updatePost(data.postId, data.body, data.hashtags);
      }
      break;
    }

    case 'core.post.edited': {
      const data = event.data as { postId?: string; body?: string };
      if (data?.postId && typeof data.body === 'string') {
        const doc = ObjectId.isValid(data.postId)
          ? await getPostsCollection().findOne({ _id: new ObjectId(data.postId), deleted: false })
          : null;
        await defaultSocialSearchService.updatePost(
          data.postId,
          data.body,
          doc?.hashtags ?? extractSocialHashtags(data.body)
        );
      }
      break;
    }

    case 'core.post.deleted': {
      const data = event.data as { postId?: string };
      if (data?.postId) {
        await defaultSocialSearchService.deletePost(data.postId);
      }
      break;
    }

    case 'core.reel.created': {
      const data = event.data as { reelId?: string; authorId?: string; at?: string };
      if (data?.reelId) {
        const doc = ObjectId.isValid(data.reelId)
          ? await getReelsCollection().findOne({ _id: new ObjectId(data.reelId), deleted: false })
          : null;
        if (doc) {
          await defaultSocialSearchService.indexReel({
            id: doc._id.toString(),
            authorId: doc.authorId,
            caption: doc.caption ?? null,
            createdAt: doc.createdAt,
            likeCount: doc.likeCount ?? 0,
            viewCount: doc.viewCount ?? 0,
          });
        }
      }
      break;
    }

    default: {
      console.log(`[EventConsumer] Unhandled event type '${event.type}' - skipping`);
      break;
    }
  }
}
