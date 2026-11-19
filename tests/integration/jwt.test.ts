import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair } from 'jose';
import { jwksService } from '../../src/auth/jwks.js';
import { verifyAccessToken } from '../../src/auth/jwt.js';
import { UnauthorizedError } from '../../src/utils/errors.js';
import { createMockAccessToken, getOrCreateTestAuthKeys } from '../mocks/jwt.mock.js';

describe('JWT Verification Layer', () => {
  beforeAll(async () => {
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);
  });

  it('successfully verifies a valid RS256 token with iss=nebron-auth and aud including core', async () => {
    const token = await createMockAccessToken({
      sub: 'usr_neo',
      email: 'neo@matrix.org',
      sessionId: 'sess_999',
    });

    const user = await verifyAccessToken(token);
    expect(user.userId).toBe('usr_neo');
    expect(user.email).toBe('neo@matrix.org');
    expect(user.sessionId).toBe('sess_999');
  });

  it('accepts audience as a single string "core"', async () => {
    const token = await createMockAccessToken({
      aud: 'core',
    });

    const user = await verifyAccessToken(token);
    expect(user.userId).toBeDefined();
  });

  it('accepts audience as an array containing "core"', async () => {
    const token = await createMockAccessToken({
      aud: ['auth', 'core', 'chat'],
    });

    const user = await verifyAccessToken(token);
    expect(user.userId).toBeDefined();
  });

  it('rejects expired tokens with 401 invalid_token', async () => {
    // Expired 10 seconds ago
    const expiredTimestamp = Math.floor(Date.now() / 1000) - 10;
    const token = await createMockAccessToken({
      exp: expiredTimestamp,
    });

    await expect(verifyAccessToken(token)).rejects.toThrow(UnauthorizedError);
    await expect(verifyAccessToken(token)).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_token',
    });
  });

  it('rejects tokens with invalid issuer (iss !== nebron-auth)', async () => {
    const token = await createMockAccessToken({
      iss: 'rogue-issuer',
    });

    await expect(verifyAccessToken(token)).rejects.toThrow(UnauthorizedError);
    await expect(verifyAccessToken(token)).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_token',
    });
  });

  it('rejects tokens where aud does NOT include core', async () => {
    const token = await createMockAccessToken({
      aud: ['chat', 'voice'],
    });

    await expect(verifyAccessToken(token)).rejects.toThrow(UnauthorizedError);
    await expect(verifyAccessToken(token)).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_token',
    });
  });

  it('rejects tokens signed by an untrusted key', async () => {
    const rogueKeys = await generateKeyPair('RS256');
    const token = await createMockAccessToken({}, rogueKeys.privateKey);

    await expect(verifyAccessToken(token)).rejects.toThrow(UnauthorizedError);
    await expect(verifyAccessToken(token)).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_token',
    });
  });

  it('rejects tokens with empty or missing string', async () => {
    await expect(verifyAccessToken('')).rejects.toThrow(UnauthorizedError);
    await expect(verifyAccessToken('')).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_token',
    });
  });
});
