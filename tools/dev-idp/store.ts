/**
 * In-memory state of the dev IdP: sign-in transactions, authorization codes and refresh
 * token families. A restart drops it all, so web sessions end at their next refresh.
 */

const MAX_ENTRIES = 10_000;

/** A map whose entries expire; the oldest entries are dropped past MAX_ENTRIES. */
export class ExpiringMap<V> {
  readonly #entries = new Map<string, { value: V; expiresAt: number }>();

  set(key: string, value: V, ttlMs: number): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (this.#entries.size > MAX_ENTRIES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
  }

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }
}

/** What the user entered on the sign-in form: the identity the tokens describe. */
export interface Identity {
  readonly sub: string;
  readonly email: string | undefined;
  readonly emailVerified: boolean;
  /** Access-token lifetime in seconds (the form's knob; e2e uses short ones). */
  readonly accessTtlS: number;
}

export interface Transaction {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: readonly string[];
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

export interface AuthorizationCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly nonce: string;
  readonly scope: readonly string[];
  readonly identity: Identity;
  readonly authTime: number;
  /** The session id; also the refresh family the code starts. */
  readonly sid: string;
  used: boolean;
}

/** One login's refresh tokens: every rotation stays in the family until it ends. */
export interface Family {
  readonly clientId: string;
  readonly scope: readonly string[];
  readonly identity: Identity;
  readonly createdAt: number;
  revoked: boolean;
}

export interface RefreshToken {
  readonly sid: string;
  /** False once rotated: presenting it again revokes the family. */
  active: boolean;
}

export const TRANSACTION_TTL_MS = 10 * 60_000;
export const CODE_TTL_MS = 60_000;
export const FAMILY_TTL_MS = 8 * 60 * 60_000;

export const transactions = new ExpiringMap<Transaction>();
export const codes = new ExpiringMap<AuthorizationCode>();
export const families = new ExpiringMap<Family>();
/** Keyed by the sha256 of the token, never the token itself. */
export const refreshTokens = new ExpiringMap<RefreshToken>();

setInterval(() => {
  transactions.sweep();
  codes.sweep();
  families.sweep();
  refreshTokens.sweep();
}, 60_000).unref();
