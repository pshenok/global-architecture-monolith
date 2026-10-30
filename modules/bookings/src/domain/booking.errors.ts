import { ConflictError, NotFoundError, PreconditionFailedError } from '@gam/kernel';

export const bookingNotFound = (id: string) =>
  new NotFoundError('BOOKING_NOT_FOUND', `booking ${id} not found`, { bookingId: id });

export const guestNotFound = (guestId: string) =>
  new PreconditionFailedError('BOOKING_GUEST_NOT_FOUND', `guest ${guestId} does not exist`, {
    guestId,
  });

export const houseNotFound = (houseId: string) =>
  new PreconditionFailedError('BOOKING_HOUSE_NOT_FOUND', `house ${houseId} does not exist`, {
    houseId,
  });

export const tooManyGuests = (guests: number, maxGuests: number) =>
  new PreconditionFailedError(
    'BOOKING_TOO_MANY_GUESTS',
    `the house sleeps at most ${maxGuests} guests`,
    {
      guests: String(guests),
      maxGuests: String(maxGuests),
    },
  );

export const datesUnavailable = (houseId: string) =>
  new ConflictError(
    'BOOKING_DATES_UNAVAILABLE',
    'the house is already booked for some of these dates',
    { houseId },
  );

export const bookingAlreadyCancelled = (id: string) =>
  new PreconditionFailedError('BOOKING_ALREADY_CANCELLED', `booking ${id} is already cancelled`, {
    bookingId: id,
  });
