import { ValidationError } from '@gam/kernel';

/** Longest stay a single booking may cover. */
export const MAX_NIGHTS = 30;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Parses a calendar date "YYYY-MM-DD" (no time, no zone) to UTC midnight epoch ms, or throws. */
export function parseCalendarDate(value: string, field: string): number {
  const match = ISO_DATE.exec(value);
  const ms = match
    ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : Number.NaN;
  if (!match || Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`${field} must be a calendar date (YYYY-MM-DD)`, [
      { field, description: 'must be a calendar date (YYYY-MM-DD)' },
    ]);
  }
  return ms;
}

/**
 * Validates a stay [checkIn, checkOut) against the current time and returns its
 * number of nights. Check-in may be today (UTC) but not in the past.
 */
export function nightsOf(checkIn: string, checkOut: string, now: Date): number {
  const start = parseCalendarDate(checkIn, 'checkIn');
  const end = parseCalendarDate(checkOut, 'checkOut');
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (start < today) {
    throw new ValidationError('checkIn must not be in the past', [
      { field: 'checkIn', description: 'must not be in the past' },
    ]);
  }
  const nights = (end - start) / DAY_MS;
  if (nights < 1 || nights > MAX_NIGHTS) {
    throw new ValidationError(`a stay must be 1..${MAX_NIGHTS} nights`, [
      { field: 'checkOut', description: `must be 1..${MAX_NIGHTS} nights after checkIn` },
    ]);
  }
  return nights;
}

/**
 * The date an open stay checks out after: today (UTC), like the check-in rule above. A
 * CONFIRMED booking with check_out later than this is upcoming or ongoing; one that
 * checked out today or earlier is history and is never cancelled.
 */
export function openStayCutoff(now: Date): string {
  return now.toISOString().slice(0, 10);
}
