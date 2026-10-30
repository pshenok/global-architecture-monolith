import { pageOf } from '@gam/platform';
import { z } from 'zod';
import type { SampleItem } from '../../domain/sample-item.ts';

/** The owner is the signed-in user; it is never taken from the body. */
export const CreateSampleItemBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).default(''),
  })
  .meta({ id: 'CreateSampleItemBody' });

export const UpdateSampleItemBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
  })
  .meta({ id: 'UpdateSampleItemBody' });

export const SampleItemView = z
  .object({
    id: z.uuid(),
    ownerId: z.uuid(),
    name: z.string(),
    description: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'SampleItem' });

export const SampleItemPage = pageOf(SampleItemView, 'SampleItemPage');

/** Domain -> REST. */
export function toSampleItemView(sampleItem: SampleItem): z.output<typeof SampleItemView> {
  const state = sampleItem.toState();
  return {
    ...state,
    createdAt: state.createdAt.toISOString(),
    updatedAt: state.updatedAt.toISOString(),
  };
}
