import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  ValidationError,
} from '@gam/kernel';
import { adminActor, serviceActor, userActor } from '@gam/kernel/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  day,
  FakeHouseCatalog,
  FakeUserDirectory,
  FixedClock,
  GUEST_ID,
  HOST_ID,
  HOUSE_ID,
  InMemoryBookingRepository,
  OTHER_HOUSE,
  PassThroughUnitOfWork,
  SequentialIds,
  STRANGER_ID,
  TERMS,
} from '../../test/fakes.ts';
import { BookingService } from './booking.service.ts';

const guest = userActor(GUEST_ID);
const host = userActor(HOST_ID);
const stranger = userActor(STRANGER_ID);

describe('BookingService', () => {
  const clock = new FixedClock();
  const stay = (from: number, to: number) => ({
    houseId: HOUSE_ID,
    checkIn: day(from, clock.now()),
    checkOut: day(to, clock.now()),
    guests: 2,
  });
  let users: FakeUserDirectory;
  let houses: FakeHouseCatalog;
  let repository: InMemoryBookingRepository;
  let service: BookingService;

  beforeEach(() => {
    users = new FakeUserDirectory();
    houses = new FakeHouseCatalog();
    repository = new InMemoryBookingRepository();
    service = new BookingService(
      repository,
      users,
      houses,
      new SequentialIds(),
      clock,
      new PassThroughUnitOfWork(),
    );
  });

  it('books for the acting user and snapshots the house owner as host', async () => {
    const booking = await service.create(guest, stay(10, 13));
    expect(booking.toState()).toMatchObject({ guestId: GUEST_ID, hostId: HOST_ID });
  });

  it('books free dates and allows back-to-back stays', async () => {
    await service.create(guest, stay(10, 13));
    await expect(service.create(guest, stay(13, 15))).resolves.toBeDefined();
  });

  it('rejects overlapping dates', async () => {
    await service.create(guest, stay(10, 13));
    await expect(service.create(guest, stay(12, 14))).rejects.toBeInstanceOf(ConflictError);
  });

  it('frees the dates on cancel', async () => {
    const booking = await service.create(guest, stay(10, 13));
    await service.cancel(guest, booking.id);
    await expect(service.create(guest, stay(10, 13))).resolves.toBeDefined();
  });

  it('rejects a missing guest account or house as a failed precondition', async () => {
    users.known.clear();
    await expect(service.create(guest, stay(10, 11))).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    users.known.add(GUEST_ID);
    houses.houses.clear();
    await expect(service.create(guest, stay(10, 11))).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
  });

  it('validates the stay before calling other services', async () => {
    users.known.clear();
    await expect(service.create(guest, stay(-1, 2))).rejects.toBeInstanceOf(ValidationError);
  });

  it('reports NOT_FOUND when cancelling an unknown booking', async () => {
    await expect(service.cancel(guest, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  describe('visibility', () => {
    it('shows a booking to its guest, its host and admins, and hides it from others', async () => {
      const { id } = await service.create(guest, stay(10, 13));
      for (const actor of [guest, host, adminActor(STRANGER_ID)]) {
        await expect(service.get(actor, id)).resolves.toMatchObject({ id });
      }
      await expect(service.get(stranger, id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('lets the host cancel, but answers a stranger as if the booking did not exist', async () => {
      const { id } = await service.create(guest, stay(10, 13));
      await expect(service.cancel(stranger, id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(service.cancel(host, id)).resolves.toMatchObject({ status: 'CANCELLED' });
    });

    it('scopes lists to the caller, and only admins list everything', async () => {
      await service.create(guest, stay(10, 11));
      await service.create(guest, stay(11, 12));
      const page = { limit: 10, after: null };
      expect((await service.list(guest, 'guest', {}, page)).items).toHaveLength(2);
      expect((await service.list(host, 'host', {}, page)).items).toHaveLength(2);
      expect((await service.list(host, 'guest', {}, page)).items).toHaveLength(0);
      expect((await service.list(stranger, 'host', {}, page)).items).toHaveLength(0);
      await expect(service.list(stranger, 'any', {}, page)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      expect((await service.list(adminActor(STRANGER_ID), 'any', {}, page)).items).toHaveLength(2);
    });
  });

  describe('cleanup after deletions (ADR-0005)', () => {
    const workload = serviceActor('bookings');
    const statusOf = async (id: string) => (await repository.findById(id))?.toState().status;
    /** A stay that checked in yesterday, which the API itself refuses to create. */
    const stayInProgress = async () => {
      const booking = await service.create(guest, stay(30, 33));
      repository.rows.set(booking.id, {
        ...booking.toState(),
        checkIn: day(-1, clock.now()),
        checkOut: day(2, clock.now()),
      });
      return booking;
    };
    /** A stay that checked out today, which the API itself refuses to create. */
    const finishedStay = async (houseId = HOUSE_ID) => {
      const booking = await service.create(guest, { ...stay(40, 41), houseId });
      repository.rows.set(booking.id, {
        ...booking.toState(),
        checkIn: day(-5, clock.now()),
        checkOut: day(0, clock.now()),
      });
      return booking;
    };

    it("cancels a deleted house's open stays, once, and keeps finished ones", async () => {
      houses.houses.set(OTHER_HOUSE, TERMS);
      const upcoming = await service.create(guest, stay(10, 13));
      const ongoing = await service.create(guest, stay(0, 3));
      const finished = await finishedStay();
      const elsewhere = await service.create(guest, { ...stay(10, 13), houseId: OTHER_HOUSE });
      expect(await service.cancelOpenStaysOfHouse(workload, HOUSE_ID)).toBe(2);
      expect(await statusOf(upcoming.id)).toBe('CANCELLED');
      expect(await statusOf(ongoing.id)).toBe('CANCELLED');
      expect(await statusOf(finished.id)).toBe('CONFIRMED');
      expect(await statusOf(elsewhere.id)).toBe('CONFIRMED');
      expect((await repository.findById(upcoming.id))?.toState().cancelledAt).toEqual(clock.now());
      expect(await service.cancelOpenStaysOfHouse(workload, HOUSE_ID)).toBe(0);
    });

    it("cancels a deleted house's stay that checked in before today", async () => {
      // Apart from the test above: it would overlap the stays checking in and out today.
      const inProgress = await stayInProgress();
      expect(await service.cancelOpenStaysOfHouse(workload, HOUSE_ID)).toBe(1);
      expect(await statusOf(inProgress.id)).toBe('CANCELLED');
    });

    it('cancels a stay that checks out tomorrow: the cutoff is today, not later', async () => {
      const booking = await service.create(guest, stay(30, 33));
      repository.rows.set(booking.id, {
        ...booking.toState(),
        checkIn: day(-1, clock.now()),
        checkOut: day(1, clock.now()),
      });
      expect(await service.cancelOpenStaysOfHouse(workload, HOUSE_ID)).toBe(1);
      expect(await statusOf(booking.id)).toBe('CANCELLED');
    });

    it("cancels a deleted guest's stays, not the stays it hosts", async () => {
      houses.houses.set(OTHER_HOUSE, TERMS);
      const asGuest = await service.create(guest, stay(10, 13));
      const inProgress = await stayInProgress();
      // Another house: it would overlap the stay in progress.
      const finished = await finishedStay(OTHER_HOUSE);
      const cancelledBefore = await service.create(guest, stay(20, 21));
      await service.cancel(guest, cancelledBefore.id);
      expect(await service.cancelOpenStaysOfGuest(workload, HOST_ID)).toBe(0);
      expect(await statusOf(asGuest.id)).toBe('CONFIRMED');
      expect(await statusOf(inProgress.id)).toBe('CONFIRMED');
      // Neither the finished stay nor the booking cancelled before.
      expect(await service.cancelOpenStaysOfGuest(workload, GUEST_ID)).toBe(2);
      expect(await statusOf(asGuest.id)).toBe('CANCELLED');
      expect(await statusOf(inProgress.id)).toBe('CANCELLED');
      expect(await statusOf(finished.id)).toBe('CONFIRMED');
    });
  });
});
