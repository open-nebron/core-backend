import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken } from './jwt.js';
import { UnauthorizedError, ForbiddenError } from '../utils/errors.js';
import { checkUserBanned } from './ban-check.js';
import { getProfilesCollection, type ProfileDocument } from '../db/mongo.js';

export async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    throw new UnauthorizedError('Authorization header is required');
  }

  const [scheme, token] = authHeader.split(' ');

  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) {
    throw new UnauthorizedError('Malformed Authorization header. Format: Bearer <token>');
  }

  const user = await verifyAccessToken(token.trim());
  request.user = user;

  // Check ban status on every authenticated request
  await checkUserBanned(user.userId);
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await authenticateRequest(request, reply);

  const profile = await getProfilesCollection().findOne({ userId: request.user.userId });
  if (!profile || !profile.isAdmin) {
    throw new ForbiddenError('Admin access required', 'not_admin');
  }

  (request as any).adminProfile = profile;
}
