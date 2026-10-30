import {
  Clock,
  IdGenerator,
  type Page,
  type PageRequest,
  UnitOfWork,
  type UserActor,
} from '@gam/kernel';
import { Injectable } from '@nestjs/common';
import { sampleItemNotFound } from '../domain/sample-item.errors.ts';
import { SampleItemRepository } from '../domain/sample-item.repository.ts';
import { SampleItem, type SampleItemChanges } from '../domain/sample-item.ts';
import { sampleItemScopeFor } from '../domain/sample-item-scope.ts';

/**
 * Use cases of the sample items module. Orchestrates the domain through ports; knows
 * nothing about HTTP, SQL or the ORM. The acting user is always the first argument (from
 * `currentUser()` in the controller), never read from context here.
 */
@Injectable()
export class SampleItemService {
  constructor(
    private readonly sampleItems: SampleItemRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async create(
    actor: UserActor,
    input: { name: string; description: string },
  ): Promise<SampleItem> {
    const sampleItem = SampleItem.create(
      { id: this.ids.newId(), ownerId: actor.userId, ...input },
      this.clock.now(),
    );
    await this.sampleItems.insert(sampleItem);
    return sampleItem;
  }

  /** Strangers get NOT_FOUND: they must not learn that the item exists. */
  async get(actor: UserActor, id: string): Promise<SampleItem> {
    const sampleItem = await this.sampleItems.findById(id);
    if (!sampleItem?.isVisibleTo(actor)) throw sampleItemNotFound(id);
    return sampleItem;
  }

  async list(actor: UserActor, page: PageRequest): Promise<Page<SampleItem>> {
    return this.sampleItems.list(sampleItemScopeFor(actor), page);
  }

  /** Read-modify-write under a row lock, so concurrent partial updates never lose each other's changes. */
  update(actor: UserActor, id: string, changes: SampleItemChanges): Promise<SampleItem> {
    return this.unitOfWork.run(async () => {
      const sampleItem = await this.sampleItems.findById(id, { forUpdate: true });
      if (!sampleItem?.isVisibleTo(actor)) throw sampleItemNotFound(id);
      sampleItem.update(changes, this.clock.now());
      await this.sampleItems.update(sampleItem);
      return sampleItem;
    });
  }

  /** Checks visibility under the row lock, so the check and the delete cannot interleave. */
  delete(actor: UserActor, id: string): Promise<void> {
    return this.unitOfWork.run(async () => {
      const sampleItem = await this.sampleItems.findById(id, { forUpdate: true });
      if (!sampleItem?.isVisibleTo(actor)) throw sampleItemNotFound(id);
      await this.sampleItems.delete(id);
    });
  }
}
