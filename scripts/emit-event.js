import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const STREAM_NAME = process.env.EVENTS_STREAM || 'zenuxs.events';

async function main() {
  const redis = new Redis(REDIS_URL);

  const userId = process.argv[2] || `usr_${Date.now()}`;
  const email = process.argv[3] || `alex.smith_${Math.floor(Math.random() * 1000)}@zenuxs.io`;

  const payload = {
    type: 'auth.user.registered',
    data: {
      userId,
      email,
    },
    timestamp: new Date().toISOString(),
  };

  const id = await redis.xadd(STREAM_NAME, '*', 'event', JSON.stringify(payload));
  console.log(`[EventPublisher] Emitted 'auth.user.registered' to stream '${STREAM_NAME}' with ID: ${id}`);
  console.log('Payload:', JSON.stringify(payload, null, 2));

  await redis.quit();
}

main().catch((err) => {
  console.error('Failed to emit event:', err);
  process.exit(1);
});
