import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisStreamEventConsumer } from '../../src/modules/events/consumer.js';
import { handleEvent } from '../../src/modules/events/handlers.js';
import { profileService } from '../../src/modules/profiles/profile.service.js';

describe('Event Consumer Layer', () => {
  let consumer: RedisStreamEventConsumer;

  beforeEach(() => {
    consumer = new RedisStreamEventConsumer({
      streamName: 'nebron.events',
      groupName: 'core-api',
      dlqStream: 'nebron.events.dlq',
      maxRetries: 3,
      backoffBaseMs: 0,
    });
  });

  describe('Event Message Parsing', () => {
    it('parses JSON string payload in "event" field', () => {
      const fields = {
        event: JSON.stringify({
          type: 'auth.user.registered',
          data: { userId: 'usr_abc', email: 'abc@nebron.io' },
        }),
      };

      const event = consumer.parseEvent('1700000000000-0', fields);
      expect(event.type).toBe('auth.user.registered');
      expect(event.data).toEqual({ userId: 'usr_abc', email: 'abc@nebron.io' });
    });

    it('parses JSON string payload in "payload" field', () => {
      const fields = {
        payload: JSON.stringify({
          type: 'auth.user.registered',
          data: { userId: 'usr_xyz', email: 'xyz@nebron.io' },
        }),
      };

      const event = consumer.parseEvent('1700000000000-1', fields);
      expect(event.type).toBe('auth.user.registered');
      expect(event.data).toEqual({ userId: 'usr_xyz', email: 'xyz@nebron.io' });
    });

    it('parses flat fields with type, userId, email', () => {
      const fields = {
        type: 'auth.user.registered',
        userId: 'usr_flat',
        email: 'flat@nebron.io',
      };

      const event = consumer.parseEvent('1700000000000-2', fields);
      expect(event.type).toBe('auth.user.registered');
      expect(event.data.userId).toBe('usr_flat');
      expect(event.data.email).toBe('flat@nebron.io');
    });

    it('parses type with nested JSON data string', () => {
      const fields = {
        type: 'auth.user.registered',
        data: JSON.stringify({ userId: 'usr_nested', email: 'nested@nebron.io' }),
      };

      const event = consumer.parseEvent('1700000000000-3', fields);
      expect(event.type).toBe('auth.user.registered');
      expect(event.data).toEqual({ userId: 'usr_nested', email: 'nested@nebron.io' });
    });
  });

  describe('Event Handlers and Idempotency', () => {
    it('successfully processes auth.user.registered and creates profile', async () => {
      const createSpy = vi.spyOn(profileService, 'createProfileFromEvent').mockResolvedValueOnce({
        userId: 'usr_test',
        username: 'testuser',
        name: null,
        dateOfBirth: null,
        bio: null,
        profilePicUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await handleEvent({
        type: 'auth.user.registered',
        data: { userId: 'usr_test', email: 'test@nebron.io' },
      });

      expect(createSpy).toHaveBeenCalledWith('usr_test', 'test@nebron.io');
    });

    it('is idempotent: duplicate auth.user.registered does not error and returns existing profile', async () => {
      const existingDoc = {
        userId: 'usr_dup',
        username: 'existing_user',
        name: null,
        dateOfBirth: null,
        bio: null,
        profilePicUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Mock profileService.createProfileFromEvent returning existing doc on duplicate
      const createSpy = vi
        .spyOn(profileService, 'createProfileFromEvent')
        .mockResolvedValue(existingDoc);

      // Call twice with same userId
      await handleEvent({
        type: 'auth.user.registered',
        data: { userId: 'usr_dup', email: 'dup@nebron.io' },
      });

      await handleEvent({
        type: 'auth.user.registered',
        data: { userId: 'usr_dup', email: 'dup@nebron.io' },
      });

      expect(createSpy).toHaveBeenCalledTimes(2);
    });

    it('logs and ignores auth.session.revoked without error', async () => {
      await expect(
        handleEvent({
          type: 'auth.session.revoked',
          data: { userId: 'usr_revoked', sessionId: 'sess_123' },
        })
      ).resolves.toBeUndefined();
    });

    it('throws on missing userId or email in auth.user.registered for DLQ handling', async () => {
      await expect(
        handleEvent({
          type: 'auth.user.registered',
          data: { userId: 'usr_bad' } as any,
        })
      ).rejects.toThrow('missing userId or email');
    });
  });

  describe('DLQ Poison Message Handling', () => {
    it('routes poison message to DLQ after exceeding max retries and ACKs original', async () => {
      const mockRedis: any = {
        xadd: vi.fn().mockResolvedValue('dlq-msg-id-1'),
        xack: vi.fn().mockResolvedValue(1),
      };

      // Inject mock redis client
      (consumer as any).redis = mockRedis;

      // Fail handleEvent
      vi.spyOn(profileService, 'createProfileFromEvent').mockRejectedValue(
        new Error('Database disk full')
      );

      const messageId = '1700000000000-99';
      const rawFields = ['event', '{"type":"auth.user.registered","data":{"bad":"data"}}'];

      // Attempt 1, 2, 3 should fail with backoff
      // Attempt 4 should exceed maxRetries and route to DLQ
      for (let i = 0; i < 3; i++) {
        await (consumer as any).processMessage(messageId, rawFields);
      }

      // 4th time: should route to DLQ and ACK
      await (consumer as any).processMessage(messageId, rawFields);

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'nebron.events.dlq',
        '*',
        'originalId',
        messageId,
        'originalStream',
        'nebron.events',
        'eventType',
        'auth.user.registered',
        'error',
        expect.stringContaining('missing userId or email'),
        'failedAt',
        expect.any(String),
        'payload',
        expect.any(String)
      );

      expect(mockRedis.xack).toHaveBeenCalledWith('nebron.events', 'core-api', messageId);
    });
  });
});
