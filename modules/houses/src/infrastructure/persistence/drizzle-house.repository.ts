import type { Page, PageRequest } from '@gam/kernel';
import { toPage } from '@gam/kernel';
import { DbContext } from '@gam/platform';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { type HouseFilter, HouseRepository } from '../../domain/house.repository.ts';
import { House } from '../../domain/house.ts';
import { type HouseRow, houses } from './schema.ts';

const toDomain = (row: HouseRow): House =>
  House.restore({
    id: row.id,
    ownerId: row.ownerId,
    title: row.title,
    description: row.description,
    address: { line1: row.addressLine1, city: row.city, countryCode: row.countryCode },
    nightlyPrice: { currencyCode: row.currencyCode, amountMinor: row.nightlyPriceMinor },
    maxGuests: row.maxGuests,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const toRow = (house: House): HouseRow => {
  const state = house.toState();
  return {
    id: state.id,
    ownerId: state.ownerId,
    title: state.title,
    description: state.description,
    addressLine1: state.address.line1,
    city: state.address.city,
    countryCode: state.address.countryCode,
    nightlyPriceMinor: state.nightlyPrice.amountMinor,
    currencyCode: state.nightlyPrice.currencyCode,
    maxGuests: state.maxGuests,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
};

/** Drizzle adapter of the HouseRepository port. */
@Injectable()
export class DrizzleHouseRepository extends HouseRepository {
  constructor(private readonly db: DbContext) {
    super();
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<House | null> {
    const query = this.db.tx.select().from(houses).where(eq(houses.id, id));
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async list(filter: HouseFilter, { limit, after }: PageRequest): Promise<Page<House>> {
    const rows = await this.db.tx
      .select()
      .from(houses)
      .where(
        and(
          after ? lt(houses.id, after) : undefined,
          filter.ownerId ? eq(houses.ownerId, filter.ownerId) : undefined,
          filter.city ? sql`lower(${houses.city}) = lower(${filter.city})` : undefined,
        ),
      )
      .orderBy(desc(houses.id))
      .limit(limit + 1);
    return toPage(rows.map(toDomain), limit);
  }

  async insert(house: House): Promise<void> {
    await this.db.tx.insert(houses).values(toRow(house));
  }

  async update(house: House): Promise<void> {
    const { id, ...row } = toRow(house);
    await this.db.tx.update(houses).set(row).where(eq(houses.id, id));
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db.tx
      .delete(houses)
      .where(eq(houses.id, id))
      .returning({ id: houses.id });
    return rows.length > 0;
  }

  async deleteByOwner(ownerId: string): Promise<readonly House[]> {
    const rows = await this.db.tx.delete(houses).where(eq(houses.ownerId, ownerId)).returning();
    return rows.map(toDomain);
  }
}
