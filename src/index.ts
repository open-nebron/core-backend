import { env } from './config/env.js';
import { connectMongo, closeMongo } from './db/mongo.js';
import { getRedisClient, closeRedis } from './db/redis.js';
import { jwksService } from './auth/jwks.js';
import { eventConsumer } from './modules/events/consumer.js';
import { buildApp } from './app.js';

async function bootstrap() {
  console.log('🚀 Starting Zenuxs Core API...');

  // 1. Connect MongoDB
  try {
    console.log(`Connecting to MongoDB at ${env.MONGO_URL}...`);
    await connectMongo();
    console.log('✅ Connected to MongoDB (zenuxs_core)');
  } catch (err: any) {
    console.error('❌ Failed to connect to MongoDB:', err.message);
    process.exit(1);
  }

  // 2. Initialize Redis
  try {
    console.log(`Connecting to Redis at ${env.REDIS_URL}...`);
    const redis = getRedisClient();
    await redis.ping();
    console.log('✅ Connected to Redis');
  } catch (err: any) {
    console.error('❌ Failed to connect to Redis:', err.message);
    process.exit(1);
  }

  // 3. Initialize JWKS cache and background refresh
  try {
    console.log(`Initializing JWKS cache from ${env.AUTH_JWKS_URL}...`);
    await jwksService.init();
    console.log('✅ JWKS cache initialized');
  } catch (err: any) {
    console.warn('⚠️ JWKS initial load warning (will retry in background):', err.message);
  }

  // 4. Start Event Consumer
  try {
    console.log(`Starting event consumer on stream '${env.EVENTS_STREAM}'...`);
    await eventConsumer.start();
    console.log('✅ Event consumer started');
  } catch (err: any) {
    console.error('❌ Failed to start event consumer:', err.message);
    process.exit(1);
  }

  // 5. Build and listen Fastify app
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    console.log(`⚡ Zenuxs Core API listening on http://0.0.0.0:${env.PORT}`);
    console.log(`📚 OpenAPI Documentation available at http://0.0.0.0:${env.PORT}/docs`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      console.log(`\nReceived ${signal}, shutting down gracefully...`);
      try {
        await app.close();
        await eventConsumer.stop();
        jwksService.stopBackgroundRefresh();
        await closeMongo();
        await closeRedis();
        console.log('👋 Shutdown complete. Goodbye!');
        process.exit(0);
      } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
      }
    });
  }
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
