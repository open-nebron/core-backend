import {
  RelationshipRepository,
  defaultRelationshipRepository,
} from './repository.js';
import {
  RelationshipEventPublisher,
  defaultRelationshipEventPublisher,
} from './events.js';
import type { MuteInput } from './validate.js';
import { getProfilesCollection } from '../../db/mongo.js';
import { computePublicUrl } from '../../lib/r2.js';

export interface BlockedUserItem {
  userId: string;
  blockedAt: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface MuteState {
  calls: boolean;
  messages: boolean;
  until: string | null;
}

export interface RelationshipResponse {
  blocked: boolean;
  mute: MuteState;
}

export interface RelationshipCheckResult {
  blocked: boolean;
  muted: {
    calls: boolean;
    messages: boolean;
  };
}

export class RelationshipService {
  private repo: RelationshipRepository;
  private publisher: RelationshipEventPublisher;

  constructor(repo?: RelationshipRepository, publisher?: RelationshipEventPublisher) {
    this.repo = repo ?? defaultRelationshipRepository;
    this.publisher = publisher ?? defaultRelationshipEventPublisher;
  }

  async blockUser(fromUserId: string, toUserId: string): Promise<void> {
    await this.repo.upsertBlock(fromUserId, toUserId, true);
    await this.publisher.publishBlocked({
      fromUserId,
      toUserId,
      at: new Date().toISOString(),
    });
  }

  async unblockUser(fromUserId: string, toUserId: string): Promise<void> {
    await this.repo.upsertBlock(fromUserId, toUserId, false);
    await this.publisher.publishUnblocked({
      fromUserId,
      toUserId,
      at: new Date().toISOString(),
    });
  }

  async muteUser(
    fromUserId: string,
    toUserId: string,
    input: MuteInput
  ): Promise<MuteState> {
    const existing = await this.repo.findByUserPair(fromUserId, toUserId);

    const calls = input.calls !== undefined ? input.calls : (existing?.muteCalls ?? false);
    const messages = input.messages !== undefined ? input.messages : (existing?.muteMessages ?? false);
    const untilDate =
      input.until !== undefined
        ? input.until
          ? new Date(input.until)
          : null
        : (existing?.muteUntil ?? null);

    await this.repo.upsertMute(fromUserId, toUserId, {
      calls,
      messages,
      until: untilDate,
    });

    const muteState: MuteState = {
      calls,
      messages,
      until: untilDate ? untilDate.toISOString() : null,
    };

    await this.publisher.publishMuted({
      fromUserId,
      toUserId,
      mute: muteState,
      at: new Date().toISOString(),
    });

    return muteState;
  }

  async unmuteUser(fromUserId: string, toUserId: string): Promise<void> {
    await this.repo.clearMute(fromUserId, toUserId);
    await this.publisher.publishUnmuted({
      fromUserId,
      toUserId,
      at: new Date().toISOString(),
    });
  }

  async getBlockedList(fromUserId: string): Promise<BlockedUserItem[]> {
    const blockedDocs = await this.repo.getBlockedUsers(fromUserId);
    if (blockedDocs.length === 0) {
      return [];
    }

    const toUserIds = blockedDocs.map((doc) => doc.toUserId);
    const profilesCol = getProfilesCollection();
    const profiles = await profilesCol
      .find({ userId: { $in: toUserIds } })
      .toArray();

    const profileMap = new Map(profiles.map((p) => [p.userId, p]));

    return blockedDocs.map((rel) => {
      const prof = profileMap.get(rel.toUserId);
      return {
        userId: rel.toUserId,
        blockedAt: rel.updatedAt ? rel.updatedAt.toISOString() : new Date().toISOString(),
        username: prof?.username || 'unknown',
        name: prof?.name || null,
        avatarUrl: prof ? computePublicUrl(prof.avatarKey, prof.updatedAt) : null,
      };
    });
  }

  async getRelationship(fromUserId: string, toUserId: string): Promise<RelationshipResponse> {
    const doc = await this.repo.findByUserPair(fromUserId, toUserId);
    if (!doc) {
      return {
        blocked: false,
        mute: {
          calls: false,
          messages: false,
          until: null,
        },
      };
    }

    return {
      blocked: doc.blocked,
      mute: {
        calls: doc.muteCalls,
        messages: doc.muteMessages,
        until: doc.muteUntil ? doc.muteUntil.toISOString() : null,
      },
    };
  }

  async checkRelationships(
    fromUserId: string | null,
    targetUserIds: string[]
  ): Promise<Record<string, RelationshipCheckResult>> {
    const result: Record<string, RelationshipCheckResult> = {};

    // Initialize all requested userIds with zero-state
    for (const id of targetUserIds) {
      result[id] = {
        blocked: false,
        muted: {
          calls: false,
          messages: false,
        },
      };
    }

    if (targetUserIds.length === 0) {
      return result;
    }

    const docs = await this.repo.findMultiple(fromUserId, targetUserIds);

    const now = Date.now();
    for (const doc of docs) {
      const targetKey = fromUserId
        ? doc.toUserId
        : (result[doc.toUserId] ? doc.toUserId : doc.fromUserId);

      if (!result[targetKey]) continue;

      const isMuteActive = !doc.muteUntil || doc.muteUntil.getTime() > now;

      result[targetKey] = {
        blocked: doc.blocked,
        muted: {
          calls: isMuteActive ? doc.muteCalls : false,
          messages: isMuteActive ? doc.muteMessages : false,
        },
      };
    }

    return result;
  }
}

export const defaultRelationshipService = new RelationshipService();
