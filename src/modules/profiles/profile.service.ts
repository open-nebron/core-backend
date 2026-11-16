import { getProfilesCollection, type ProfileDocument } from '../../db/mongo.js';
import { validateUsername } from './username.rules.js';
import { generateUniqueUsername } from './username.generator.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/errors.js';

export interface ProfileResponse {
  userId: string;
  username: string;
  name: string | null;
  dateOfBirth: string | null;
  bio: string | null;
  profilePicUrl: string | null;
  createdAt: string;
  updatedAt?: string;
}

export function formatProfileResponse(doc: ProfileDocument): ProfileResponse {
  return {
    userId: doc.userId,
    username: doc.username,
    name: doc.name ?? null,
    dateOfBirth: doc.dateOfBirth ? doc.dateOfBirth.toISOString().split('T')[0] : null,
    bio: doc.bio ?? null,
    profilePicUrl: doc.profilePicUrl ?? null,
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
    data: { name?: string; dateOfBirth?: string; bio?: string }
  ): Promise<ProfileDocument> {
    const collection = getProfilesCollection();

    const updateFields: Partial<ProfileDocument> = {
      updatedAt: new Date(),
    };

    if (data.name !== undefined) {
      updateFields.name = data.name;
    }

    if (data.dateOfBirth !== undefined) {
      updateFields.dateOfBirth = new Date(data.dateOfBirth);
    }

    if (data.bio !== undefined) {
      updateFields.bio = data.bio;
    }

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
      name: null,
      dateOfBirth: null,
      bio: null,
      profilePicUrl: null,
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
}

export const profileService = new ProfileService();
