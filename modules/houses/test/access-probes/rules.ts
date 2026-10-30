/**
 * Self-test of tools/check-access.ts, read as production code of the houses module: one
 * probe per rule, each refused by that rule alone, so a rule that stops working fails lint
 * even when the other probes still pass. Nothing imports or runs this file.
 */
import type { UserActor } from '@gam/kernel';
import { Access } from '@gam/platform';
import { Controller, Get, Injectable } from '@nestjs/common';
import type { FastifyInstance } from 'fastify';
import { ClsServiceManager } from 'nestjs-cls'; // refused

// A route added on the raw server, outside the controllers (the AuthGuard never sees it).
export function rawRoute(app: FastifyInstance): void {
  app.get('/v1/raw', () => 'raw'); // refused
}

// A test helper named by a string, a computed module specifier, Reflect, a metadata key.
export const helperName = '@gam/kernel/testing'; // refused
export const load = (name: string) => import(name); // refused
export const keys = Reflect.getMetadataKeys(Object); // refused
export const accessKey = 'gam:access-policy'; // refused

// `x!` on a value that is always null: never, which converts to an actor; and a
// suppression of the whole style group (the layer rules among it) to allow it.
const nothing = null;
// biome-ignore lint/style: probe of a group suppression // refused
export const forced = nothing!; // refused

// An actor taken by constructor injection (no decorator on the parameter).
@Injectable()
export class InjectedHolder {
  constructor(readonly actor: UserActor) {} // refused
}

// @Access on something other than a plain route method.
@Controller('rules')
export class RulesController {
  @Get('getter')
  @Access.user() // refused
  get value(): number {
    return 1;
  }
}

// The request context, written by hand.
export const context = ClsServiceManager.getClsService(); // refused
