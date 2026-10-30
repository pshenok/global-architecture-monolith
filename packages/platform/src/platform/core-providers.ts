import { Clock, IdGenerator } from '@gam/kernel';
import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

/** UUIDv7: time-ordered, so ids sort by creation time and work as keyset cursors. */
@Injectable()
export class UuidV7IdGenerator extends IdGenerator {
  newId(): string {
    return uuidv7();
  }
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
