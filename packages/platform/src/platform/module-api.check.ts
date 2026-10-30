import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { isModuleApi, unguardedMembers } from './module-api.ts';

/**
 * Boot check: a module's public API holds no methods as instance fields, which the
 * @ModuleApi guard cannot wrap (they would run inside the caller's transaction).
 */
@Injectable()
export class ModuleApiCheck implements OnApplicationBootstrap {
  constructor(private readonly discovery: DiscoveryService) {}

  onApplicationBootstrap(): void {
    const problems: string[] = [];
    for (const wrapper of this.discovery.getProviders()) {
      const { metatype } = wrapper;
      const instance: unknown = wrapper.instance;
      if (!isModuleApi(metatype) || typeof instance !== 'object' || instance === null) continue;
      for (const member of unguardedMembers(instance)) {
        problems.push(`${(metatype as { name: string }).name}.${member}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `@ModuleApi classes with methods written as fields, which skip the transaction guard: ${problems.join(', ')}. Write them as methods (ADR-0002).`,
      );
    }
  }
}
