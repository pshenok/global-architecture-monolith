import { NotFoundError, PermissionDeniedError } from '@gam/kernel';
import { adminActor, identityActor, userActor } from '@gam/kernel/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FixedClock,
  InMemoryUserRepository,
  PassThroughUnitOfWork,
  RecordingUserEvents,
  SequentialIds,
} from '../../test/fakes.ts';
import { UserService } from './user.service.ts';

describe('UserService', () => {
  let service: UserService;
  let clock: FixedClock;
  let events: RecordingUserEvents;

  beforeEach(() => {
    clock = new FixedClock();
    events = new RecordingUserEvents();
    service = new UserService(
      new InMemoryUserRepository(),
      new SequentialIds(),
      clock,
      new PassThroughUnitOfWork(),
      events,
    );
  });

  const ann = identityActor('https://idp.example', 'ann-sub', 'Ann@Example.com');

  it('registers an identity once and resolves it to its user', async () => {
    const user = await service.register(ann, { fullName: 'Ann' });
    expect(user.toState()).toMatchObject({ email: 'ann@example.com', roles: [] });
    await expect(service.resolve(ann)).resolves.toEqual({ userId: user.id, roles: [] });
    const again = await service.register(ann, { fullName: 'Ann' }).catch((e: unknown) => e);
    expect(again).toMatchObject({ reason: 'USER_ALREADY_REGISTERED' });
  });

  it('keeps identities of different issuers apart, even with the same subject', async () => {
    const other = identityActor('https://other-idp.example', 'ann-sub', null);
    const first = await service.register(ann, { fullName: 'Ann' });
    const second = await service.register(other, { fullName: 'Ann too' });
    expect(first.id).not.toBe(second.id);
    await expect(service.resolve(other)).resolves.toMatchObject({ userId: second.id });
  });

  it('rejects another identity with an email that is taken', async () => {
    await service.register(ann, { fullName: 'Ann' });
    const imposter = identityActor('https://idp.example', 'other-sub', 'ann@example.com');
    await expect(service.register(imposter, { fullName: 'X' })).rejects.toMatchObject({
      reason: 'USER_EMAIL_TAKEN',
    });
  });

  it('resolves an unregistered identity to nobody', async () => {
    await expect(service.resolve(ann)).resolves.toBeNull();
  });

  const admin = adminActor('01900000-0000-7000-8000-00000000000a');

  it('shows a user to itself and to admins only', async () => {
    const user = await service.register(ann, { fullName: 'Ann' });
    const self = userActor(user.id);
    await expect(service.get(self, user.id)).resolves.toMatchObject({ email: 'ann@example.com' });
    await expect(service.get(admin, user.id)).resolves.toBeDefined();
    await expect(service.get(userActor('someone-else'), user.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  const login = (n: string) => identityActor('https://idp.example', `${n}-sub`, `${n}@x.io`);

  it('lists users newest first, for admins only', async () => {
    for (const n of ['a', 'b', 'c']) await service.register(login(n), { fullName: n });
    const first = await service.list(admin, { limit: 2, after: null });
    expect(first.items.map((u) => u.fullName)).toEqual(['c', 'b']);
    const second = await service.list(admin, { limit: 2, after: first.nextAfter });
    expect(second.items.map((u) => u.fullName)).toEqual(['a']);
    await expect(service.list(userActor('u1'), { limit: 2, after: null })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('updates with a new timestamp, for the user itself or an admin', async () => {
    const user = await service.register(ann, { fullName: 'A' });
    clock.advance(1_000);
    const updated = await service.update(userActor(user.id), user.id, { fullName: 'Ann' });
    expect(updated.updatedAt.getTime()).toBe(user.createdAt.getTime() + 1_000);
    await expect(
      service.update(userActor('someone-else'), user.id, { fullName: 'Hacked' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.update(admin, user.id, { fullName: 'By admin' })).resolves.toMatchObject({
      fullName: 'By admin',
    });
  });

  it('deletes a user and its login, for the user itself only (or an admin)', async () => {
    const user = await service.register(ann, { fullName: 'Ann' });
    await expect(service.delete(userActor('someone-else'), user.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(events.deletedUsers).toEqual([]);
    await service.delete(userActor(user.id), user.id);
    await expect(service.resolve(ann)).resolves.toBeNull();
    expect(events.deletedUsers).toEqual([user.id]);
  });

  it('reports NOT_FOUND for unknown ids', async () => {
    await expect(service.get(admin, 'missing')).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.delete(admin, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});
