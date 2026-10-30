import { type Page, type PageRequest, toPage } from '@gam/kernel';
import { DbContext, translateDbError } from '@gam/platform';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { sampleItemNameTaken } from '../../domain/sample-item.errors.ts';
import { SampleItemRepository } from '../../domain/sample-item.repository.ts';
import { SampleItem } from '../../domain/sample-item.ts';
import type { SampleItemScope } from '../../domain/sample-item-scope.ts';
import { type SampleItemRow, sampleItems } from './schema.ts';

const toDomain = (row: SampleItemRow): SampleItem => SampleItem.restore(row);

/** Drizzle adapter of the SampleItemRepository port. */
@Injectable()
export class DrizzleSampleItemRepository extends SampleItemRepository {
  constructor(private readonly db: DbContext) {
    super();
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<SampleItem | null> {
    const query = this.db.tx.select().from(sampleItems).where(eq(sampleItems.id, id));
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async list(scope: SampleItemScope, { limit, after }: PageRequest): Promise<Page<SampleItem>> {
    const rows = await this.db.tx
      .select()
      .from(sampleItems)
      .where(
        and(
          scope.kind === 'owner' ? eq(sampleItems.ownerId, scope.ownerId) : undefined,
          after ? lt(sampleItems.id, after) : undefined,
        ),
      )
      .orderBy(desc(sampleItems.id))
      .limit(limit + 1);
    return toPage(rows.map(toDomain), limit);
  }

  async insert(sampleItem: SampleItem): Promise<void> {
    try {
      await this.db.tx.insert(sampleItems).values(sampleItem.toState());
    } catch (error) {
      throw translateDbError(error, {
        sample_items_owner_id_name_key: () => sampleItemNameTaken(sampleItem.name),
      });
    }
  }

  async update(sampleItem: SampleItem): Promise<void> {
    const { id, ...state } = sampleItem.toState();
    try {
      await this.db.tx.update(sampleItems).set(state).where(eq(sampleItems.id, id));
    } catch (error) {
      throw translateDbError(error, {
        sample_items_owner_id_name_key: () => sampleItemNameTaken(sampleItem.name),
      });
    }
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db.tx
      .delete(sampleItems)
      .where(eq(sampleItems.id, id))
      .returning({ id: sampleItems.id });
    return rows.length > 0;
  }
}
