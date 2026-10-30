import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { CONFIG } from '../config/config.ts';
import { AccessRoutes } from './access-routes.ts';
import { AccessTokenVerifier } from './access-token-verifier.ts';
import type { AuthConfig } from './auth.config.ts';
import { IdpKeySet } from './idp-key-set.ts';

/** One key set per trusted issuer, started at boot (not blocking it). */
export const IDP_KEY_SETS = Symbol('IDP_KEY_SETS');

class IdpKeySetsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(IDP_KEY_SETS) private readonly keySets: ReadonlyMap<string, IdpKeySet>) {}

  onApplicationShutdown(): void {
    for (const keySet of this.keySets.values()) keySet.stop();
  }
}

/** Authentication building blocks; PlatformModule binds the AuthGuard and the IdentityResolver. */
@Global()
@Module({
  // AccessRoutes reads the controllers.
  imports: [DiscoveryModule],
  providers: [
    {
      provide: IDP_KEY_SETS,
      inject: [CONFIG],
      useFactory: (config: AuthConfig) => {
        const keySets = new Map<string, IdpKeySet>();
        for (const issuer of config.AUTH_ISSUERS) {
          const keySet = new IdpKeySet(issuer.jwksUri, {
            refreshMs: config.AUTH_JWKS_REFRESH_S * 1_000,
            unknownKidCooldownMs: config.AUTH_JWKS_UNKNOWN_KID_COOLDOWN_S * 1_000,
            maxStaleMs: config.AUTH_JWKS_MAX_STALE_S * 1_000,
            timeoutMs: config.AUTH_JWKS_TIMEOUT_MS,
          });
          keySet.start();
          keySets.set(issuer.issuer, keySet);
        }
        return keySets;
      },
    },
    {
      provide: AccessTokenVerifier,
      inject: [CONFIG, IDP_KEY_SETS],
      useFactory: (config: AuthConfig, keySets: ReadonlyMap<string, IdpKeySet>) =>
        new AccessTokenVerifier(
          new Map(
            config.AUTH_ISSUERS.map((issuer) => [
              issuer.issuer,
              { config: issuer, keys: keySets.get(issuer.issuer) as IdpKeySet },
            ]),
          ),
          config.AUTH_CLOCK_TOLERANCE_S,
        ),
    },
    IdpKeySetsLifecycle,
    AccessRoutes,
  ],
  exports: [IDP_KEY_SETS, AccessTokenVerifier, AccessRoutes],
})
export class AuthModule {}
