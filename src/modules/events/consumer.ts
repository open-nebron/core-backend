import os from 'node:os';
import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import { handleEvent } from './handlers.js';
import type { ZenuxsEvent } from './types.js';

export interface EventConsumer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RedisStreamConsumerOptions {
  redisUrl?: string;
  streamName?: string;
  groupName?: string;
  consumerName?: string;
  dlqStream?: string;
  maxRetries?: number;
  blockTimeoutMs?: number;
  backoffBaseMs?: number;
}

export class RedisStreamEventConsumer implements EventConsumer {
  private redis: Redis | null = null;
  private isRunning = false;
  private loopPromise: Promise<void> | null = null;
  private readonly streamName: string;
  private readonly groupName: string;
  private readonly consumerName: string;
  private readonly dlqStream: string;
  private readonly maxRetries: number;
  private readonly blockTimeoutMs: number;
  private readonly backoffBaseMs: number;
  private readonly redisUrl: string;
  private readonly retryCounts = new Map<string, number>();

  constructor(options: RedisStreamConsumerOptions = {}) {
    this.redisUrl = options.redisUrl ?? env.REDIS_URL;
    this.streamName = options.streamName ?? env.EVENTS_STREAM;
    this.groupName = options.groupName ?? env.EVENTS_GROUP;
    this.consumerName = options.consumerName ?? os.hostname();
    this.dlqStream = options.dlqStream ?? `${this.streamName}.dlq`;
    this.maxRetries = options.maxRetries ?? 3;
    this.blockTimeoutMs = options.blockTimeoutMs ?? 2000;
    this.backoffBaseMs = options.backoffBaseMs ?? 1000;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;

    this.redis = new Redis(this.redisUrl, {
      maxRetriesPerRequest: null, // Required for blocking commands
      lazyConnect: false,
    });

    this.isRunning = true;
    await this.initConsumerGroup();
    this.loopPromise = this.consumeLoop();
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }

  private getStreams(): string[] {
    const list = [this.streamName];
    if (this.streamName !== 'zenuxs.events') {
      list.push('zenuxs.events');
    }
    return list;
  }

  private async initConsumerGroup(): Promise<void> {
    if (!this.redis) return;
    for (const stream of this.getStreams()) {
      try {
        await this.redis.xgroup('CREATE', stream, this.groupName, '$', 'MKSTREAM');
        console.log(`[EventConsumer] Created consumer group '${this.groupName}' on stream '${stream}'`);
      } catch (err: any) {
        if (err.message && err.message.includes('BUSYGROUP')) {
          console.log(`[EventConsumer] Consumer group '${this.groupName}' on stream '${stream}' already exists`);
        } else {
          console.error(`[EventConsumer] Error creating consumer group on '${stream}':`, err.message);
        }
      }
    }
  }

  private async consumeLoop(): Promise<void> {
    const streams = this.getStreams();
    console.log(
      `[EventConsumer] Started consuming streams [${streams.join(', ')}] as group '${this.groupName}', consumer '${this.consumerName}'`
    );

    while (this.isRunning && this.redis) {
      try {
        const streamIds = streams.map(() => '>');
        // Read new messages from group
        const response = (await (this.redis as any).xreadgroup(
          'GROUP',
          this.groupName,
          this.consumerName,
          'BLOCK',
          this.blockTimeoutMs,
          'COUNT',
          10,
          'STREAMS',
          ...streams,
          ...streamIds
        )) as [string, [string, string[]][]][] | null;

        if (!response || response.length === 0) {
          continue;
        }

        for (const [stream, messages] of response) {
          for (const [messageId, rawFields] of messages) {
            await this.processMessage(stream, messageId, rawFields);
          }
        }
      } catch (err: any) {
        if (!this.isRunning) break;
        console.error('[EventConsumer] Error in stream reading loop:', err.message);
        // Brief sleep on unexpected error to prevent tight spin
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private parseMessageFields(rawFields: string[]): Record<string, string> {
    const fields: Record<string, string> = {};
    for (let i = 0; i < rawFields.length; i += 2) {
      fields[rawFields[i]] = rawFields[i + 1];
    }
    return fields;
  }

  public parseEvent(messageId: string, fields: Record<string, string>): ZenuxsEvent {
    // Format A: JSON string in 'event' or 'payload' or 'data' field
    const rawPayload = fields.event || fields.payload;
    if (rawPayload) {
      try {
        const parsed = JSON.parse(rawPayload);
        return {
          id: messageId,
          type: parsed.type || fields.type || 'unknown',
          data: parsed.data || parsed,
          timestamp: parsed.timestamp,
        };
      } catch {
        // Fall through to other formats if JSON parsing fails
      }
    }

    // Format B: fields.type and fields.data (where data is JSON string or object)
    if (fields.type) {
      let data: any = fields.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          // not JSON, leave as is
        }
      }

      // Format C: Flat fields like type, userId, email
      if (!data) {
        const { type, ...rest } = fields;
        data = rest;
      }

      return {
        id: messageId,
        type: fields.type,
        data,
      };
    }

    return {
      id: messageId,
      type: 'unknown',
      data: fields,
    };
  }

  private async processMessage(
    streamOrMessageId: string,
    messageIdOrRawFields: any,
    maybeRawFields?: string[]
  ): Promise<void> {
    let stream = this.streamName;
    let messageId: string;
    let rawFields: string[];

    if (maybeRawFields !== undefined) {
      stream = streamOrMessageId;
      messageId = messageIdOrRawFields;
      rawFields = maybeRawFields;
    } else {
      messageId = streamOrMessageId;
      rawFields = messageIdOrRawFields;
    }

    const fields = this.parseMessageFields(rawFields);
    const event = this.parseEvent(messageId, fields);

    try {
      // Process event through handlers
      await handleEvent(event);

      // Acknowledge only after successful processing
      await this.redis?.xack(stream, this.groupName, messageId);
      this.retryCounts.delete(messageId);
    } catch (err: any) {
      console.error(
        `[EventConsumer] Error processing message ${messageId} (event ${event.type}):`,
        err.message
      );

      const attempts = (this.retryCounts.get(messageId) || 0) + 1;
      this.retryCounts.set(messageId, attempts);

      if (attempts > this.maxRetries) {
        console.error(
          `[EventConsumer] Message ${messageId} exceeded max retries (${this.maxRetries}). Routing to DLQ '${this.dlqStream}'`
        );
        try {
          await this.routeToDlq(stream, messageId, event, fields, err.message);
          // ACK from primary stream after successfully moving to DLQ
          await this.redis?.xack(stream, this.groupName, messageId);
          this.retryCounts.delete(messageId);
        } catch (dlqErr: any) {
          console.error(`[EventConsumer] Failed to write message ${messageId} to DLQ:`, dlqErr.message);
        }
      } else {
        // Backoff before retry
        const backoffMs = Math.min(this.backoffBaseMs * Math.pow(2, attempts - 1), 5000);
        console.warn(
          `[EventConsumer] Retrying message ${messageId} in ${backoffMs}ms (attempt ${attempts}/${this.maxRetries})`
        );
        if (backoffMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }
  }

  private async routeToDlq(
    originalStream: string,
    originalId: string,
    event: ZenuxsEvent,
    rawFields: Record<string, string>,
    errorMessage: string
  ): Promise<void> {
    if (!this.redis) return;

    await this.redis.xadd(
      `${originalStream}.dlq`,
      '*',
      'originalId',
      originalId,
      'originalStream',
      originalStream,
      'eventType',
      event.type,
      'error',
      errorMessage,
      'failedAt',
      new Date().toISOString(),
      'payload',
      JSON.stringify(rawFields)
    );
  }
}

export const eventConsumer = new RedisStreamEventConsumer();
