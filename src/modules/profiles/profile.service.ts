import {
  getProfilesCollection,
  type ProfileDocument,
  type UserTheme,
  type MessageRequestPolicy,
  type UserPrivacy,
  DEFAULT_PRIVACY,
} from '../../db/mongo.js';
import { getRedisClient } from '../../db/redis.js';
import { validateUsername } from './username.rules.js';
import { generateUniqueUsername } from './username.generator.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/errors.js';
import { computePublicUrl, deleteObject, type MediaKind } from '../../lib/r2.js';
import { env } from '../../config/env.js';

export interface ProfileResponse {
  userId: string;
  username: string;
  name: string | null;
  dateOfBirth: string | null;
  about: string | null;
  bio: string | null;
  language: string;
  theme: UserTheme;
  messageRequestPolicy: MessageRequestPolicy;
  avatarUrl: string | null;
  bannerUrl: string | null;
  createdAt: string;
  updatedAt?: string;
}

export function formatProfileResponse(doc: ProfileDocument): ProfileResponse {
  let dobStr: string | null = null;
  if (doc.dateOfBirth) {
    dobStr = typeof doc.dateOfBirth === 'string'
      ? doc.dateOfBirth
      : doc.dateOfBirth.toISOString().split('T')[0];
  }

  return {
    userId: doc.userId,
    username: doc.username,
    name: doc.name ?? null,
    dateOfBirth: dobStr,
    about: doc.about ?? null,
    bio: doc.bio ?? null,
    language: doc.language || env.DEFAULT_LANGUAGE,
    theme: doc.theme || 'system',
    messageRequestPolicy: doc.messageRequestPolicy || 'known',
    avatarUrl: computePublicUrl(doc.avatarKey, doc.updatedAt),
    bannerUrl: computePublicUrl(doc.bannerKey, doc.updatedAt),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : undefined,
  };
}

export class ProfileService {
  async getProfileByUserId(userId: string): Promise<ProfileDocument | null> {
    const collection = getProfilesCollection();
    return collection.findOne({ userId });
  }

  async getProfileByUsername(username: string): Promise<ProfileDocument | null> {
    const collection = getProfilesCollection();
    return collection.findOne({ username: username.toLowerCase() });
  }

  async isUsernameTaken(username: string): Promise<boolean> {
    const collection = getProfilesCollection();
    const count = await collection.countDocuments(
      { username: username.toLowerCase() },
      { limit: 1 }
    );
    return count > 0;
  }

  async updateProfile(
    userId: string,
    data: {
      name?: string;
      dateOfBirth?: string;
      about?: string;
      bio?: string;
      language?: string;
      theme?: UserTheme;
      messageRequestPolicy?: MessageRequestPolicy;
    }
  ): Promise<ProfileDocument> {
    const collection = getProfilesCollection();

    const updateFields: Partial<ProfileDocument> = {
      updatedAt: new Date(),
    };

    if (data.name !== undefined) updateFields.name = data.name;
    if (data.dateOfBirth !== undefined) updateFields.dateOfBirth = data.dateOfBirth;
    if (data.about !== undefined) updateFields.about = data.about;
    if (data.bio !== undefined) updateFields.bio = data.bio;
    if (data.language !== undefined) updateFields.language = data.language;
    if (data.theme !== undefined) updateFields.theme = data.theme;
    if (data.messageRequestPolicy !== undefined) updateFields.messageRequestPolicy = data.messageRequestPolicy;

    const result = await collection.findOneAndUpdate(
      { userId },
      { $set: updateFields },
      { returnDocument: 'after' }
    );

    if (!result) {
      throw new NotFoundError('Profile not found', 'profile_not_found');
    }

    return result;
  }

  async updateMediaKey(
    userId: string,
    kind: MediaKind,
    newKey: string | null
  ): Promise<ProfileDocument> {
    const collection = getProfilesCollection();
    const existing = await this.getProfileByUserId(userId);

    if (!existing) {
      throw new NotFoundError('Profile not found', 'profile_not_found');
    }

    const previousKey = kind === 'avatar' ? existing.avatarKey : existing.bannerKey;

    const updateFields: Partial<ProfileDocument> = {
      updatedAt: new Date(),
    };

    if (kind === 'avatar') {
      updateFields.avatarKey = newKey;
    } else {
      updateFields.bannerKey = newKey;
    }

    const result = await collection.findOneAndUpdate(
      { userId },
      { $set: updateFields },
      { returnDocument: 'after' }
    );

    if (!result) {
      throw new NotFoundError('Profile not found', 'profile_not_found');
    }

    // Best effort async delete of the previous object if replaced or removed
    if (previousKey && previousKey !== newKey) {
      deleteObject(previousKey).catch((err) => {
        console.warn(`[R2] Warning: failed to delete previous ${kind} key '${previousKey}':`, err);
      });
    }

    return result;
  }

  async updateUsername(userId: string, rawUsername: string): Promise<{ username: string }> {
    const validation = validateUsername(rawUsername);
    if (!validation.ok) {
      throw new BadRequestError(
        validation.reason === 'reserved'
          ? 'This username is reserved'
          : validation.reason === 'profane'
          ? 'This username contains inappropriate language'
          : 'Invalid username format',
        'invalid_username'
      );
    }

    const normalized = validation.normalized;
    const existing = await this.getProfileByUsername(normalized);

    if (existing && existing.userId !== userId) {
      throw new ConflictError('Username is already taken', 'username_taken');
    }

    const collection = getProfilesCollection();
    const updateResult = await collection.updateOne(
      { userId },
      { $set: { username: normalized, updatedAt: new Date() } }
    );

    if (updateResult.matchedCount === 0) {
      throw new NotFoundError('Profile not found', 'profile_not_found');
    }

    return { username: normalized };
  }

  async createProfileFromEvent(userId: string, email: string): Promise<ProfileDocument> {
    const collection = getProfilesCollection();

    // Idempotent: check if profile already exists for this userId
    const existing = await collection.findOne({ userId });
    if (existing) {
      return existing;
    }

    // Auto-generate unique username
    const username = await generateUniqueUsername(email, (candidate) =>
      this.isUsernameTaken(candidate)
    );

    const now = new Date();
    const doc: ProfileDocument = {
      userId,
      username,
      email: email || null,
      name: null,
      dateOfBirth: null,
      about: null,
      bio: null,
      language: env.DEFAULT_LANGUAGE,
      theme: 'system',
      messageRequestPolicy: 'known',
      avatarKey: null,
      bannerKey: null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await collection.insertOne(doc);
      return doc;
    } catch (err: any) {
      // Handle race condition: duplicate key on userId
      if (err.code === 11000 && err.keyPattern?.userId) {
        const raceExisting = await collection.findOne({ userId });
        if (raceExisting) return raceExisting;
      }
      throw err;
    }
  }

  async getPrivacy(userId: string): Promise<UserPrivacy> {
    const profile = await this.getProfileByUserId(userId);
    if (!profile) {
      throw new NotFoundError('Profile not found', 'profile_not_found');
    }
    return profile.privacy || DEFAULT_PRIVACY;
  }

  async updatePrivacy(userId: string, privacyPatch: Partial<UserPrivacy>): Promise<UserPrivacy> {
    const collection = getProfilesCollection();
    const existing = await this.getProfileByUserId(userId);
    if (!existing) {
      throw new NotFoundError('Profile not found', 'profile_not_found');
    }

    const currentPrivacy = existing.privacy || DEFAULT_PRIVACY;
    const updatedPrivacy: UserPrivacy = {
      showOnlineStatus:
        privacyPatch.showOnlineStatus !== undefined
          ? privacyPatch.showOnlineStatus
          : currentPrivacy.showOnlineStatus,
      showLastSeen:
        privacyPatch.showLastSeen !== undefined
          ? privacyPatch.showLastSeen
          : currentPrivacy.showLastSeen,
      sendReadReceipts:
        privacyPatch.sendReadReceipts !== undefined
          ? privacyPatch.sendReadReceipts
          : currentPrivacy.sendReadReceipts,
    };

    await collection.updateOne(
      { userId },
      {
        $set: {
          privacy: updatedPrivacy,
          updatedAt: new Date(),
        },
      }
    );

    // Invalidate Redis cache
    try {
      const redis = getRedisClient();
      await redis.del(`user:privacy:${userId}`);
    } catch {
      // Best-effort cache invalidation
    }

    return updatedPrivacy;
  }
}

export const profileService = new ProfileService();
