import { createLocalJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';
import { env } from '../config/env.js';

export interface JwksCacheStatus {
  isLoaded: boolean;
  ageSeconds: number | null;
  lastFetchedAt: string | null;
  keyCount: number;
  jwksUrl: string;
  lastError: string | null;
}

export class JwksService {
  private jwksUrl: string;
  private cachedJwks: JSONWebKeySet | null = null;
  private localKeySet: JWTVerifyGetKey | null = null;
  private lastFetchedAt: Date | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private inFlightFetch: Promise<void> | null = null;
  private refreshIntervalMs = 10 * 60 * 1000; // 10 minutes

  constructor(jwksUrl: string = env.AUTH_JWKS_URL) {
    this.jwksUrl = jwksUrl;
  }

  public async init(): Promise<void> {
    await this.fetchJwks();
    this.startBackgroundRefresh();
  }

  public async fetchJwks(): Promise<void> {
    if (this.inFlightFetch) {
      return this.inFlightFetch;
    }
    this.inFlightFetch = this._doFetchJwks();
    try {
      await this.inFlightFetch;
    } finally {
      this.inFlightFetch = null;
    }
  }

  private async _doFetchJwks(): Promise<void> {
    try {
      const response = await fetch(this.jwksUrl, {
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch JWKS from ${this.jwksUrl}: HTTP ${response.status} ${response.statusText}`);
      }

      const jwks = (await response.json()) as JSONWebKeySet;
      if (!jwks.keys || !Array.isArray(jwks.keys)) {
        throw new Error(`Invalid JWKS structure: 'keys' array missing`);
      }

      this.cachedJwks = jwks;
      this.localKeySet = createLocalJWKSet(jwks);
      this.lastFetchedAt = new Date();
      this.lastError = null;
    } catch (err: any) {
      this.lastError = err.message || 'Unknown error fetching JWKS';
      // In production/boot, do not crash the app if auth-service is momentarily starting up
      console.warn(`[JWKS] Warning: unable to fetch JWKS from ${this.jwksUrl}: ${this.lastError}`);
    }
  }

  public startBackgroundRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      this.fetchJwks().catch((err) => {
        console.error('[JWKS] Background refresh failed:', err);
      });
    }, this.refreshIntervalMs);
    this.refreshTimer.unref();
  }

  public stopBackgroundRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  public getKeySet(): JWTVerifyGetKey {
    if (!this.localKeySet) {
      throw new Error('JWKS cache is empty or uninitialized');
    }
    return this.localKeySet;
  }

  public setLocalJwks(jwks: JSONWebKeySet): void {
    this.cachedJwks = jwks;
    this.localKeySet = createLocalJWKSet(jwks);
    this.lastFetchedAt = new Date();
    this.lastError = null;
  }

  public isHealthy(): boolean {
    return this.cachedJwks !== null && (this.cachedJwks.keys?.length ?? 0) > 0;
  }

  public getStatus(): JwksCacheStatus {
    const ageSeconds = this.lastFetchedAt
      ? Math.floor((Date.now() - this.lastFetchedAt.getTime()) / 1000)
      : null;

    return {
      isLoaded: this.isHealthy(),
      ageSeconds,
      lastFetchedAt: this.lastFetchedAt ? this.lastFetchedAt.toISOString() : null,
      keyCount: this.cachedJwks?.keys?.length ?? 0,
      jwksUrl: this.jwksUrl,
      lastError: this.lastError,
    };
  }
}

export const jwksService = new JwksService();
