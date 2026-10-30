import { ANONYMOUS, ValidationError } from '@gam/kernel';
import { adminActor, userActor } from '@gam/kernel/testing';
import { describe, expect, it } from 'vitest';
import { SampleItem } from './sample-item.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const later = new Date('2026-01-02T00:00:00.000Z');

describe('SampleItem', () => {
  it('normalizes input and stamps both timestamps on create', () => {
    const item = SampleItem.create(
      { id: 'i1', ownerId: 'u1', name: '  Lamp ', description: ' warm ' },
      now,
    );
    expect(item.toState()).toEqual({
      id: 'i1',
      ownerId: 'u1',
      name: 'Lamp',
      description: 'warm',
      createdAt: now,
      updatedAt: now,
    });
  });

  it('rejects an empty or too long name', () => {
    expect(() =>
      SampleItem.create({ id: 'i1', ownerId: 'u1', name: '   ', description: '' }, now),
    ).toThrow(ValidationError);
    expect(() =>
      SampleItem.create({ id: 'i1', ownerId: 'u1', name: 'x'.repeat(201), description: '' }, now),
    ).toThrow(ValidationError);
  });

  it('updates only the given fields and bumps updatedAt', () => {
    const item = SampleItem.create(
      { id: 'i1', ownerId: 'u1', name: 'Lamp', description: 'warm' },
      now,
    );
    item.update({ description: 'cold' }, later);
    expect(item.toState()).toMatchObject({
      name: 'Lamp',
      description: 'cold',
      createdAt: now,
      updatedAt: later,
    });
  });

  it('keeps updatedAt when nothing changes', () => {
    const item = SampleItem.create({ id: 'i1', ownerId: 'u1', name: 'Lamp', description: '' }, now);
    item.update({ name: 'Lamp' }, later);
    expect(item.updatedAt).toEqual(now);
  });

  it('is visible to its owner and to admins only', () => {
    const item = SampleItem.create({ id: 'i1', ownerId: 'u1', name: 'Lamp', description: '' }, now);
    expect(item.isVisibleTo(userActor('u1'))).toBe(true);
    expect(item.isVisibleTo(adminActor('u9'))).toBe(true);
    expect(item.isVisibleTo(userActor('u2'))).toBe(false);
    expect(item.isVisibleTo(ANONYMOUS)).toBe(false);
  });
});
