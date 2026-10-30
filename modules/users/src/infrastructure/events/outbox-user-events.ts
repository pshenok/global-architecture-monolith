import { Outbox } from '@gam/platform';
import { Injectable } from '@nestjs/common';
import { UserEvents } from '../../application/ports/user-events.ts';
import { USER_DELETED } from '../../contracts/user-events.ts';

/** UserEvents through the transactional outbox: delivered once the change commits. */
@Injectable()
export class OutboxUserEvents extends UserEvents {
  constructor(private readonly outbox: Outbox) {
    super();
  }

  deleted(userId: string): Promise<void> {
    return this.outbox.add(USER_DELETED, userId, { userId });
  }
}
