import { ValidationError } from '@gam/kernel';
import { describe, expect, it } from 'vitest';
import { nightsOf, openStayCutoff, parseCalendarDate } from './stay.ts';

const now = new Date('2026-06-01T23:30:00.000Z');

describe('stay rules', () => {
  it('counts nights of a half-open range', () => {
    expect(nightsOf('2026-06-01', '2026-06-04', now)).toBe(3);
  });

  it('allows check-in today (UTC) but not yesterday', () => {
    expect(nightsOf('2026-06-01', '2026-06-02', now)).toBe(1);
    expect(() => nightsOf('2026-05-31', '2026-06-02', now)).toThrow(/past/);
  });

  it('rejects empty, inverted and too long stays', () => {
    expect(() => nightsOf('2026-06-02', '2026-06-02', now)).toThrow(ValidationError);
    expect(() => nightsOf('2026-06-05', '2026-06-02', now)).toThrow(ValidationError);
    expect(() => nightsOf('2026-06-02', '2026-07-03', now)).toThrow(/1\.\.30/);
  });

  it('rejects impossible calendar dates', () => {
    expect(() => parseCalendarDate('2026-02-30', 'checkIn')).toThrow(ValidationError);
    expect(() => parseCalendarDate('2026-6-1', 'checkIn')).toThrow(ValidationError);
  });

  it('puts the open-stay cutoff on the current UTC day', () => {
    expect(openStayCutoff(now)).toBe('2026-06-01');
    expect(openStayCutoff(new Date('2026-06-02T00:30:00+02:00'))).toBe('2026-06-01');
    // Just after UTC midnight: a local-time cutoff would say yesterday west of UTC.
    expect(openStayCutoff(new Date('2026-06-02T00:30:00Z'))).toBe('2026-06-02');
  });
});
