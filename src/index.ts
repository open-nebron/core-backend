import { env } from './config/env.js';
import { connectMongo, closeMongo } from './db/mongo.js';
import { getRedisClient, closeRedis } from './db/redis.js';
import { jwksService } from './auth/jwks.js';
import { eventConsumer } from './modules/events/consumer.js';
import { buildApp } from './app.js';
import { startStoryCleanupScheduler, stopStoryCleanupScheduler } from './jobs/story-cleanup.js';
import { startReelJobsScheduler, stopReelJobsScheduler } from './jobs/reel-jobs.js';
import {
  startAnalyticsRollupScheduler,
  stopAnalyticsRollupScheduler,
} from './jobs/analytics-rollup.js';
import { defaultSocialSearchService } from './modules/search/meili.service.js';

async function bootstrap() {
  console.log('[CoreAPI] Starting Nebron Core API...');

  // 1. Connect MongoDB
  try {
    console.log(`[CoreAPI] Connecting to MongoDB at ${env.MONGO_URL}...`);
    await connectMongo();
    console.log('[CoreAPI] Connected to MongoDB (nebron_core)');
  } catch (err: any) {
    console.error('[CoreAPI] Failed to connect to MongoDB:', err.message);
    process.exit(1);
  }

  // 2. Initialize Redis
  try {
    console.log(`[CoreAPI] Connecting to Redis at ${env.REDIS_URL}...`);
    const redis = getRedisClient();
    await redis.ping();
    console.log('[CoreAPI] Connected to Redis');
  } catch (err: any) {
    console.error('[CoreAPI] Failed to connect to Redis:', err.message);
    process.exit(1);
  }

  // 3. Initialize JWKS cache and background refresh
  try {
    console.log(`[CoreAPI] Initializing JWKS cache from ${env.AUTH_JWKS_URL}...`);
    await jwksService.init();
    console.log('[CoreAPI] JWKS cache initialized');
  } catch (err: any) {
    console.warn('[CoreAPI] JWKS initial load warning (will retry in background):', err.message);
  }

  // 4. Start Event Consumer
  try {
    console.log(`[CoreAPI] Starting event consumer on stream '${env.EVENTS_STREAM}'...`);
    await eventConsumer.start();
    console.log('[CoreAPI] Event consumer started');
  } catch (err: any) {
    console.error('[CoreAPI] Failed to start event consumer:', err.message);
    process.exit(1);
  }

  // 5. Build and listen Fastify app
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    startStoryCleanupScheduler();
    startReelJobsScheduler();
    startAnalyticsRollupScheduler();
    void defaultSocialSearchService.backfillMissing().catch(() => {});
    console.log(`[CoreAPI] Listening on http://0.0.0.0:${env.PORT}`);
    console.log(`[CoreAPI] OpenAPI Documentation available at http://0.0.0.0:${env.PORT}/docs`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      console.log(`\n[CoreAPI] Received ${signal}, shutting down gracefully...`);
      try {
        stopStoryCleanupScheduler();
        stopReelJobsScheduler();
        stopAnalyticsRollupScheduler();
        await app.close();
        await eventConsumer.stop();
        jwksService.stopBackgroundRefresh();
        await closeMongo();
        await closeRedis();
        console.log('[CoreAPI] Shutdown complete. Goodbye!');
        process.exit(0);
      } catch (err) {
        console.error('[CoreAPI] Error during shutdown:', err);
        process.exit(1);
      }
    });
  }
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
