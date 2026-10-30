import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import type pg from 'pg';
import { Access } from '../auth/access.ts';
import { IDP_KEY_SETS } from '../auth/auth.module.ts';
import type { IdpKeySet, KeySetState } from '../auth/idp-key-set.ts';
import { PG_POOL } from '../database/tokens.ts';

const WORST: readonly KeySetState[] = ['unavailable', 'stale', 'ok'];
const DATABASE_PROBE_MS = 1_000;

/**
 * /healthz: liveness (the process answers).
 * /readyz:  readiness. 503 until the database has answered once since this process
 *           started (a rollout with a wrong DATABASE_URL never becomes ready, so it cannot
 *           replace working replicas), and while the app shuts down (Fastify answers 503
 *           to new requests on close). After that the database and the identity provider
 *           are only reported, with `status: "degraded"` when one is not well: every
 *           replica shares them, so failing readiness on them would take the whole API out
 *           of rotation, while the requests that need them already fail on their own.
 */
@ApiExcludeController()
@SkipThrottle()
@Controller()
export class HealthController {
  /** Whether the database answered at least once since this process started. */
  private databaseSeen = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(IDP_KEY_SETS) private readonly keySets: ReadonlyMap<string, IdpKeySet>,
  ) {}

  @Get('healthz')
  @Access.public('liveness and readiness probes', { ignoreToken: true })
  live() {
    return { status: 'ok' };
  }

  @Get('readyz')
  @Access.public('liveness and readiness probes', { ignoreToken: true })
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const database = (await this.probeDatabase()) ? 'ok' : 'unavailable';
    if (database === 'ok') this.databaseSeen = true;
    const states = [...this.keySets.values()].map((keySet) => keySet.state);
    const identityProvider = WORST.find((state) => states.includes(state)) ?? 'ok';
    const status = !this.databaseSeen
      ? 'starting'
      : database === 'ok' && identityProvider === 'ok'
        ? 'ok'
        : 'degraded';
    void reply.status(this.databaseSeen ? 200 : 503);
    return { status, database, identityProvider };
  }

  private async probeDatabase(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), DATABASE_PROBE_MS);
    });
    const query = this.pool.query('select 1').then(
      () => true,
      () => false,
    );
    try {
      return await Promise.race([query, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
