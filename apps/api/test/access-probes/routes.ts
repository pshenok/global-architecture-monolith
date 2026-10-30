/**
 * Self-test of tools/check-access.ts, which reads this file as if it were production code
 * in the api app: every line marked `refused` must be refused, and no other line. Each
 * probe is a way to open a route without a listed, reviewed decorator, or to serve one
 * outside the controllers, that a review found. Nothing imports or runs this file.
 */
import { createRequire } from 'node:module'; // refused
import * as platform from '@gam/platform';
import {
  ACCESS_POLICY,
  Access,
  Access as Open, // refused
} from '@gam/platform';
import {
  applyDecorators,
  Controller,
  Get,
  Inject,
  Injectable,
  type MiddlewareConsumer, // refused
  type NestModule, // refused
  SetMetadata,
} from '@nestjs/common';
import { DiscoveryService, HttpAdapterHost, ModuleRef } from '@nestjs/core'; // refused

const Maintenance = () => Access.public('maintenance'); // refused
const Catalogue = () => applyDecorators(Get(), Access.public('catalogue')); // refused
const keep = <T>(_: TemplateStringsArray, value: T) => value;
const openly = keep`${Access.public('partner feed')}`; // refused
const shorthand = { Access }; // refused
const TAG = ['gam', 'access-policy'].join(':');
const load = createRequire(import.meta.url); // refused
const ignore = true;

@Controller('probe')
export class ProbeController {
  @Get('listed')
  @Access.public('world-readable catalogue')
  listed() {
    return load;
  }

  @Get('probes')
  @Access.public('liveness', { ignoreToken: true })
  probes() {}

  @Get('signup')
  @Access.identity()
  signup() {}

  @Get('mine')
  @Access.user()
  mine() {}

  @Get('ns')
  @platform.Access.public('namespace') // refused
  namespace() {}

  @Get('raw')
  @SetMetadata(ACCESS_POLICY, { kind: 'public' }) // refused
  raw() {}

  @Get('key')
  @SetMetadata('gam:access-policy', { kind: 'public' }) // refused
  key() {
    Reflect.defineMetadata(TAG, { kind: 'public' }, ProbeController.prototype.raw); // refused
  }

  @Get('reason')
  @Access.public(`templated ${TAG}`) // refused
  reason() {}

  @Get('flag')
  @Access.public('computed flag', { ignoreToken: ignore }) // refused
  flag() {}

  handler = () => [Maintenance, Catalogue, openly, shorthand, Open]; // refused
}

@Injectable()
export class Feed {
  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost, // refused
    private readonly discovery: DiscoveryService, // refused
    private readonly modules: ModuleRef, // refused
  ) {}

  open() {
    this.host.httpAdapter.get('/v1/feed', () => [this.discovery, this.modules]); // refused
  }
}

export class FeedModule implements NestModule {
  // refused
  configure(consumer: MiddlewareConsumer) {
    // refused
    consumer.apply(() => undefined).forRoutes('{*path}'); // refused
  }
}
