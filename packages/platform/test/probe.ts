import { ConflictError } from '@gam/kernel';
import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Access } from '../src/auth/access.ts';
import { currentActor, currentIdentity, currentUser } from '../src/auth/actor-context.ts';

const Page = z.object({ size: z.coerce.number().int().min(1).max(10) });
const Note = z.object({ text: z.string().min(1) });

/** Routes of every access kind and every error class, for the platform's HTTP tests. */
@Controller('probe')
export class ProbeController {
  @Get('public')
  @Access.public('probe catalogue')
  open() {
    return { actor: currentActor() };
  }

  @Get('user')
  @Access.user()
  user() {
    return { actor: currentUser() };
  }

  @Get('admin')
  @Access.admin()
  admin() {
    return { actor: currentUser() };
  }

  @Post('register')
  @Access.identity()
  register() {
    return { actor: currentIdentity() };
  }

  @Get('conflict')
  @Access.user()
  conflict() {
    throw new ConflictError('PROBE_TAKEN', 'that probe is taken', { probeId: 'p-1' });
  }

  @Get('deadlock')
  @Access.user()
  deadlock() {
    // What a driver error looks like behind Drizzle's wrapper: no repository translated it.
    throw new Error('Failed query', {
      cause: Object.assign(new Error('deadlock detected'), { code: '40P01', severity: 'ERROR' }),
    });
  }

  @Get('statement-timeout')
  @Access.user()
  statementTimeout() {
    throw Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
      severity: 'ERROR',
    });
  }

  @Get('boom')
  @Access.user()
  boom() {
    throw new Error('secret internals: password=hunter2');
  }

  @Get('page')
  @Access.user()
  page(@Query({ schema: Page }) query: z.output<typeof Page>) {
    return query;
  }

  @Post('notes')
  @Access.user()
  note(@Body({ schema: Note }) body: z.output<typeof Note>) {
    return body;
  }
}

@Module({ controllers: [ProbeController] })
export class ProbeModule {}
