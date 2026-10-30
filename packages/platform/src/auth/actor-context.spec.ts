import { ClsServiceManager } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';
import {
  currentActor,
  currentEvent,
  currentService,
  currentUser,
  enterActor,
  enterEventDelivery,
  userActorOf,
} from './actor-context.ts';

const inContext = <T>(work: () => T): T => ClsServiceManager.getClsService().run(work);
const USER = '01900000-0000-7000-8000-000000000001';

describe('the request context', () => {
  it('holds the actor the kit entered', () => {
    inContext(() => {
      enterActor(userActorOf(USER, ['admin']));
      expect(currentUser()).toEqual({ kind: 'user', userId: USER, roles: ['admin'] });
    });
    expect(currentActor()).toEqual({ kind: 'anonymous' });
  });

  it('never takes a value put there by hand for an actor or an event', () => {
    inContext(() => {
      const cls = ClsServiceManager.getClsService();
      for (const key of ['gam.auth.actor', 'gam.events.event', 'gam', 'actor']) {
        cls.set(key, { kind: 'user', userId: USER, roles: ['admin'] });
      }
      const store = cls.get() as Record<string | symbol, unknown>;
      for (const symbol of Object.getOwnPropertySymbols(store)) {
        store[symbol] = { kind: 'service', name: 'houses' };
      }
      expect(currentActor()).toEqual({ kind: 'anonymous' });
      expect(() => currentService()).toThrow(/requires a module/);
      expect(currentEvent()).toBeUndefined();
    });
  });

  it('runs an event delivery as the subscribing module, with a frozen event', () => {
    inContext(() => {
      const cls = ClsServiceManager.getClsService();
      enterEventDelivery(cls, 'bookings', {
        id: 'e1',
        type: 'houses.v1.HouseDeletedEvent',
        producer: 'houses',
        aggregateId: 'h1',
        occurredAt: new Date(0),
        attempt: 2,
      });
      expect(currentService()).toEqual({ kind: 'service', name: 'bookings' });
      expect(currentEvent()).toMatchObject({ id: 'e1', attempt: 2 });
      expect(Object.isFrozen(currentEvent())).toBe(true);
    });
  });
});
