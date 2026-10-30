import { NotFoundError, PermissionDeniedError, PreconditionFailedError } from '@gam/kernel';
import { adminActor, serviceActor, userActor } from '@gam/kernel/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeUserDirectory,
  FixedClock,
  houseInput,
  InMemoryHouseRepository,
  OWNER_ID,
  PassThroughUnitOfWork,
  RecordingHouseEvents,
  SequentialIds,
} from '../../test/fakes.ts';
import { HouseService } from './house.service.ts';

const owner = userActor(OWNER_ID);

describe('HouseService', () => {
  let users: FakeUserDirectory;
  let events: RecordingHouseEvents;
  let service: HouseService;

  beforeEach(() => {
    users = new FakeUserDirectory(new Set([OWNER_ID]));
    events = new RecordingHouseEvents();
    service = new HouseService(
      new InMemoryHouseRepository(),
      users,
      new SequentialIds(),
      new FixedClock(),
      new PassThroughUnitOfWork(),
      events,
    );
  });

  it('lists a house for an existing owner', async () => {
    const house = await service.create(owner, houseInput());
    await expect(service.get(house.id)).resolves.toMatchObject({ ownerId: OWNER_ID });
  });

  it('refuses an owner the users module does not know', async () => {
    users.known.clear();
    await expect(service.create(owner, houseInput())).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
  });

  it('filters by owner and case-insensitive city', async () => {
    const other = '01900000-0000-7000-8000-0000000000bb';
    users.known.add(other);
    await service.create(owner, houseInput());
    await service.create(
      owner,
      houseInput({ address: { line1: '2 Main', city: 'Kyiv', countryCode: 'UA' } }),
    );
    await service.create(userActor(other), houseInput());
    const inKyiv = await service.list({ city: 'KYIV' }, { limit: 10, after: null });
    expect(inKyiv.items).toHaveLength(1);
    const ofOther = await service.list({ ownerId: other }, { limit: 10, after: null });
    expect(ofOther.items.map((h) => h.ownerId)).toEqual([other]);
  });

  it('reports NOT_FOUND for unknown ids', async () => {
    await expect(service.update(owner, 'missing', { maxGuests: 2 })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('lets the owner and admins change or delete a house, nobody else', async () => {
    const house = await service.create(owner, houseInput());
    const stranger = userActor('01900000-0000-7000-8000-0000000000bb');
    await expect(service.update(stranger, house.id, { maxGuests: 2 })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(service.delete(stranger, house.id)).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      service.update(adminActor('admin'), house.id, { maxGuests: 2 }),
    ).resolves.toMatchObject({
      maxGuests: 2,
    });
    expect(events.deletedHouses).toEqual([]);
    await service.delete(owner, house.id);
    await expect(service.get(house.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(events.deletedHouses).toEqual([house.id]);
  });

  it("removes a gone owner's houses, each with its event, and nobody else's", async () => {
    const first = await service.create(owner, houseInput());
    const second = await service.create(owner, houseInput({ title: 'Garden flat' }));
    const otherOwner = '01900000-0000-7000-8000-0000000000cc';
    users.known.add(otherOwner);
    const kept = await service.create(userActor(otherOwner), houseInput());
    const workload = serviceActor('houses');
    expect(await service.removeAllOf(workload, OWNER_ID)).toBe(2);
    expect(events.deletedHouses.sort()).toEqual([first.id, second.id].sort());
    await expect(service.get(kept.id)).resolves.toBeDefined();
    expect(await service.removeAllOf(workload, OWNER_ID)).toBe(0);
  });
});
