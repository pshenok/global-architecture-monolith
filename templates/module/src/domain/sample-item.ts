import { type Actor, isAdmin, ValidationError } from '@gam/kernel';

/** Persisted state of a SampleItem. */
export interface SampleItemState {
  readonly id: string;
  /** The user who created it (a users module id). */
  readonly ownerId: string;
  readonly name: string;
  readonly description: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SampleItemChanges {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
}

export const SAMPLE_ITEM_NAME_MAX = 200;
export const SAMPLE_ITEM_DESCRIPTION_MAX = 2000;

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > SAMPLE_ITEM_NAME_MAX) {
    throw new ValidationError(`name must be 1..${SAMPLE_ITEM_NAME_MAX} characters`, [
      { field: 'name', description: `must be 1..${SAMPLE_ITEM_NAME_MAX} characters` },
    ]);
  }
  return trimmed;
}

function normalizeDescription(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length > SAMPLE_ITEM_DESCRIPTION_MAX) {
    throw new ValidationError(
      `description must be at most ${SAMPLE_ITEM_DESCRIPTION_MAX} characters`,
      [
        {
          field: 'description',
          description: `must be at most ${SAMPLE_ITEM_DESCRIPTION_MAX} characters`,
        },
      ],
    );
  }
  return trimmed;
}

/**
 * SampleItem aggregate. All business rules about a sample item live here, as
 * plain TypeScript: no framework, no database, no transport.
 * Create new instances with `create` (validates) and rebuild stored ones with
 * `restore` (trusts the database).
 */
export class SampleItem {
  private constructor(private state: SampleItemState) {}

  static create(
    input: { id: string; ownerId: string; name: string; description: string },
    now: Date,
  ): SampleItem {
    return new SampleItem({
      id: input.id,
      ownerId: input.ownerId,
      name: normalizeName(input.name),
      description: normalizeDescription(input.description),
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(state: SampleItemState): SampleItem {
    return new SampleItem({ ...state });
  }

  get id(): string {
    return this.state.id;
  }

  get ownerId(): string {
    return this.state.ownerId;
  }

  /**
   * Only its owner (and admins) may see or change an item. Callers answer anyone else
   * NOT_FOUND, so strangers cannot even learn that it exists.
   */
  isVisibleTo(actor: Actor): boolean {
    return (actor.kind === 'user' && actor.userId === this.state.ownerId) || isAdmin(actor);
  }

  get name(): string {
    return this.state.name;
  }

  get description(): string {
    return this.state.description;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  /** Applies the given changes; fields left undefined stay as they are. */
  update(changes: SampleItemChanges, now: Date): void {
    const name = changes.name === undefined ? this.state.name : normalizeName(changes.name);
    const description =
      changes.description === undefined
        ? this.state.description
        : normalizeDescription(changes.description);
    if (name === this.state.name && description === this.state.description) return;
    this.state = { ...this.state, name, description, updatedAt: now };
  }

  toState(): SampleItemState {
    return { ...this.state };
  }
}
