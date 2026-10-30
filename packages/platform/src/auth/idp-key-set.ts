import { DependencyUnavailableError } from '@gam/kernel';
import { Logger } from '@nestjs/common';
import {
  type CompactJWSHeaderParameters,
  createLocalJWKSet,
  type FlattenedJWSInput,
  type JSONWebKeySet,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';

export type KeySetState = 'ok' | 'stale' | 'unavailable';

export interface IdpKeySetOptions {
  readonly refreshMs: number;
  readonly unknownKidCooldownMs: number;
  readonly maxStaleMs: number;
  readonly timeoutMs: number;
}

/**
 * After a failed fetch the loop retries with backoff: up to 5 s without usable keys, up
 * to 30 s while the last good keys still work (and never past the moment they stop).
 */
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5_000;
const STALE_RETRY_MAX_MS = 30_000;

export const identityProviderUnavailable = () =>
  new DependencyUnavailableError(
    'IDENTITY_PROVIDER_UNAVAILABLE',
    'the identity provider cannot be reached; retry later',
  );

/**
 * Public keys of one identity provider, kept current in the background.
 *
 * jose's createRemoteJWKSet waits for a reload on the request path once its cache is
 * old and fails the request when that reload fails, so an IdP outage would turn into
 * slow 401s for everyone. Instead:
 * - one background loop fetches the keys: every `refreshMs`, and with a short backoff
 *   after a failure, so it picks up a recovered provider within seconds;
 * - the last good keys stay in use for up to `maxStaleMs`; after that requests get
 *   503, never 401, and never start a fetch of their own (they only wait for one
 *   that is already running);
 * - a token with an unknown `kid` triggers at most one extra fetch per cooldown, so
 *   rotation is picked up within seconds and forged kids cannot hammer the provider.
 *   It is a 401 only when the last fetch succeeded without that kid; 503 otherwise.
 */
export class IdpKeySet {
  private readonly logger = new Logger(IdpKeySet.name);
  private local: JWTVerifyGetKey | undefined;
  private kids = new Set<string>();
  private loadedAt = 0;
  private refreshing: Promise<boolean> | undefined;
  private lastUnknownKidRefresh = Number.NEGATIVE_INFINITY;
  private lastRefreshFailed = false;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    readonly jwksUri: string,
    private readonly options: IdpKeySetOptions,
    private readonly fetchJson: (url: string, timeoutMs: number) => Promise<unknown> = fetchJwks,
  ) {}

  /** Starts the background loop (first fetch now). Does not block. */
  start(): void {
    void this.loop(RETRY_MIN_MS);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  get state(): KeySetState {
    if (!this.local || Date.now() - this.loadedAt > this.options.maxStaleMs) return 'unavailable';
    return this.lastRefreshFailed ? 'stale' : 'ok';
  }

  /** The `getKey` callback for jose's jwtVerify. */
  readonly getKey = async (
    header: CompactJWSHeaderParameters,
    token: FlattenedJWSInput,
  ): Promise<CryptoKey> => {
    if (this.state === 'unavailable') {
      // The background loop owns the retries: a request may wait for a fetch that is
      // already running, but never starts one (that would let clients pace IdP calls).
      await this.refreshing;
      if (this.state === 'unavailable') throw identityProviderUnavailable();
    }
    if (header.kid && !this.kids.has(header.kid)) {
      const now = Date.now();
      if (now - this.lastUnknownKidRefresh >= this.options.unknownKidCooldownMs) {
        this.lastUnknownKidRefresh = now;
        await this.refresh();
      } else {
        await this.refreshing;
      }
      // Unknown to a set we could not refresh: the key may be new, so this is not a 401.
      if (!this.kids.has(header.kid) && this.lastRefreshFailed) {
        throw identityProviderUnavailable();
      }
    }
    return (this.local as JWTVerifyGetKey)(header, token) as Promise<CryptoKey>;
  };

  /** One shared fetch at a time; resolves to whether it succeeded. */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.load().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async load(): Promise<boolean> {
    try {
      const jwks = parseJwks(await this.fetchJson(this.jwksUri, this.options.timeoutMs));
      this.local = createLocalJWKSet(jwks);
      this.kids = new Set(jwks.keys.map((key) => key.kid).filter((kid): kid is string => !!kid));
      this.loadedAt = Date.now();
      this.lastRefreshFailed = false;
      return true;
    } catch (error) {
      this.lastRefreshFailed = true;
      this.logger.warn(
        `JWKS ${this.jwksUri} not refreshed (keeping the last good keys): ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private async loop(retryMs: number): Promise<void> {
    if (this.stopped) return;
    const ok = await this.refresh();
    if (this.stopped) return;
    const state = this.state;
    let delayMs = ok
      ? this.options.refreshMs * (0.9 + Math.random() * 0.2)
      : Math.min(
          retryMs,
          state === 'unavailable' ? RETRY_MAX_MS : STALE_RETRY_MAX_MS,
          this.options.refreshMs,
        );
    if (!ok && state === 'stale') {
      // Wake up just after the last good keys expire: from then on the 5 s cap applies,
      // and requests never fetch themselves.
      const untilUnusableMs = this.loadedAt + this.options.maxStaleMs - Date.now();
      delayMs = Math.min(delayMs, untilUnusableMs + RETRY_MIN_MS);
    }
    const nextRetryMs = ok ? RETRY_MIN_MS : Math.min(retryMs * 2, STALE_RETRY_MAX_MS);
    this.timer = setTimeout(() => void this.loop(nextRetryMs), delayMs);
    this.timer.unref();
  }
}

/** A JWKS document; a set with duplicate kids is rejected as a whole. */
function parseJwks(value: unknown): JSONWebKeySet {
  const keys = (value as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('not a JWKS (no keys)');
  const kids = keys.map((key) => (key as { kid?: unknown }).kid);
  if (kids.some((kid) => typeof kid !== 'string')) throw new Error('every key needs a kid');
  if (new Set(kids).size !== kids.length) throw new Error('duplicate kids');
  // jose checks each key's own fields when it imports the key.
  return { keys: keys as JWK[] };
}

async function fetchJwks(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
