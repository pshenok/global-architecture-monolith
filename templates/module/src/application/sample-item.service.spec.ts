import { ConflictError, NotFoundError } from '@gam/kernel';
import { adminActor, userActor } from '@gam/kernel/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FixedClock,
  InMemorySampleItemRepository,
  PassThroughUnitOfWork,
  SequentialIds,
} from '../../test/fakes.ts';
import { SampleItemService } from './sample-item.service.ts';

const owner = userActor('01900000-0000-7000-8000-0000000000a1');
const stranger = userActor('01900000-0000-7000-8000-0000000000b1');

describe('SampleItemService', () => {
  let repository: InMemorySampleItemRepository;
  let clock: FixedClock;
  let service: SampleItemService;

  beforeEach(() => {
    repository = new InMemorySampleItemRepository();
    clock = new FixedClock();
    service = new SampleItemService(
      repository,
      new SequentialIds(),
      clock,
      new PassThroughUnitOfWork(),
    );
  });

  it('creates an item owned by the acting user and reads it back', async () => {
    const created = await service.create(owner, { name: 'Lamp', description: '' });
    expect(created.ownerId).toBe(owner.userId);
    await expect(service.get(owner, created.id)).resolves.toMatchObject({ name: 'Lamp' });
  });

  it('rejects a duplicate name of the same owner only', async () => {
    await service.create(owner, { name: 'Lamp', description: '' });
    await expect(
      service.create(owner, { name: 'Lamp', description: 'again' }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      service.create(stranger, { name: 'Lamp', description: '' }),
    ).resolves.toBeDefined();
  });

  it("pages the caller's items newest first; admins see everyone's", async () => {
    for (const name of ['a', 'b', 'c']) await service.create(owner, { name, description: '' });
    await service.create(stranger, { name: 'theirs', description: '' });
    const first = await service.list(owner, { limit: 2, after: null });
    expect(first.items.map((i) => i.name)).toEqual(['c', 'b']);
    const second = await service.list(owner, { limit: 2, after: first.nextAfter });
    expect(second.items.map((i) => i.name)).toEqual(['a']);
    expect(second.nextAfter).toBeNull();
    const all = await service.list(adminActor('admin'), { limit: 10, after: null });
    expect(all.items).toHaveLength(4);
  });

  it('updates with a new timestamp', async () => {
    const created = await service.create(owner, { name: 'Lamp', description: '' });
    clock.advance(1_000);
    const updated = await service.update(owner, created.id, { description: 'warm' });
    expect(updated.description).toBe('warm');
    expect(updated.updatedAt.getTime()).toBe(created.createdAt.getTime() + 1_000);
  });

  it('answers strangers NOT_FOUND, exactly like unknown ids', async () => {
    const created = await service.create(owner, { name: 'Lamp', description: '' });
    for (const id of [created.id, 'missing']) {
      await expect(service.get(stranger, id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(service.update(stranger, id, { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(service.delete(stranger, id)).rejects.toBeInstanceOf(NotFoundError);
    }
  });
});
