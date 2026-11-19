import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  type KeyLike,
  type JWK,
  type JSONWebKeySet,
} from 'jose';

export interface TestAuthKeys {
  privateKey: KeyLike;
  publicKey: KeyLike;
  publicJwk: JWK;
  jwks: JSONWebKeySet;
}

let authKeys: TestAuthKeys | null = null;

export async function getOrCreateTestAuthKeys(): Promise<TestAuthKeys> {
  if (authKeys) return authKeys;

  const { publicKey, privateKey } = await generateKeyPair('RS256', {
    extractable: true,
  });

  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-id-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  const jwks: JSONWebKeySet = {
    keys: [jwk],
  };

  authKeys = {
    privateKey,
    publicKey,
    publicJwk: jwk,
    jwks,
  };

  return authKeys;
}

export interface MockTokenPayload {
  sub?: string;
  userId?: string;
  email?: string;
  sessionId?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number | string;
  [key: string]: any;
}

export async function createMockAccessToken(
  payloadOverrides: MockTokenPayload = {},
  keyOverride?: KeyLike
): Promise<string> {
  const keys = await getOrCreateTestAuthKeys();
  const signingKey = keyOverride || keys.privateKey;

  const userId = payloadOverrides.sub ?? payloadOverrides.userId ?? 'usr_1234567890';
  const email = payloadOverrides.email ?? 'neo@nebron.io';
  const sessionId = payloadOverrides.sessionId ?? 'sess_abc123';
  const issuer = payloadOverrides.iss !== undefined ? payloadOverrides.iss : 'nebron-auth';
  const audience = payloadOverrides.aud !== undefined ? payloadOverrides.aud : ['core', 'auth'];
  const exp = payloadOverrides.exp !== undefined ? payloadOverrides.exp : '1h';

  const jwt = new SignJWT({
    userId,
    email,
    sessionId,
    ...payloadOverrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: keys.publicJwk.kid })
    .setSubject(userId);

  if (issuer) jwt.setIssuer(issuer);
  if (audience) jwt.setAudience(audience);
  if (exp) jwt.setExpirationTime(exp);
  jwt.setIssuedAt();

  return jwt.sign(signingKey);
}
