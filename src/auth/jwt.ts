import { jwtVerify, type JWTPayload } from 'jose';
import { jwksService } from './jwks.js';
import { UnauthorizedError } from '../utils/errors.js';
import type { AuthUser } from '../types/fastify.js';

export interface VerifyJwtOptions {
  issuer?: string;
  audience?: string;
  algorithms?: string[];
}

export async function verifyAccessToken(
  token: string,
  options: VerifyJwtOptions = {}
): Promise<AuthUser> {
  const issuer = options.issuer ?? 'zenuxs-auth';
  const audience = options.audience ?? 'core';
  const algorithms = options.algorithms ?? ['RS256'];

  if (!token) {
    throw new UnauthorizedError('Missing authentication token');
  }

  let keySet;
  try {
    keySet = jwksService.getKeySet();
  } catch (err: any) {
    throw new UnauthorizedError('Authentication service keys currently unavailable');
  }

  try {
    const { payload } = await jwtVerify(token, keySet, {
      issuer,
      audience,
      algorithms,
    });

    const userId = (payload.sub || (payload as any).userId) as string | undefined;
    if (!userId) {
      throw new UnauthorizedError('Token is missing user identifier (sub)');
    }

    const email = (payload as any).email as string | undefined;
    const sessionId = ((payload as any).sessionId || (payload as any).sid) as string | undefined;

    return {
      userId,
      email: email || '',
      sessionId,
    };
  } catch (error: any) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }
    // Handle jose errors (JWTExpired, JWSSignatureVerificationFailed, JWTClaimValidationFailed, etc.)
    throw new UnauthorizedError(error.message || 'Invalid token');
  }
}
