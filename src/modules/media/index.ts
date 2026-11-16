import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

/**
 * Media Module (Out of Scope for initial core-api task)
 * TODO: Cloudflare R2 presigned URLs, media metadata, avatar uploads.
 */
export const mediaRoutes: FastifyPluginAsync = async (_app: FastifyInstance) => {
  // TODO: Media upload routes to be implemented in subsequent milestone
};
