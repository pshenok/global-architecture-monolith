import {
  Access,
  currentUser,
  IdParam,
  keysetPaging,
  PageQuery,
  ProblemDetails,
} from '@gam/platform';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { SampleItemService } from '../../application/sample-item.service.ts';
import {
  CreateSampleItemBody,
  SampleItemPage,
  SampleItemView,
  toSampleItemView,
  UpdateSampleItemBody,
} from './sample-items.schemas.ts';

/**
 * HTTP adapter of the sample items module: validate the request, call one use case with
 * the acting user, map the result. No business logic here; DomainErrors become problem
 * details in the platform's filter. Every route declares @Access (ADR-0004).
 */
@ApiTags('sample-items')
@ApiResponse({ status: 400, description: 'Invalid input', standardSchema: ProblemDetails })
@Controller('v1/sample-items')
export class SampleItemsController {
  constructor(private readonly sampleItems: SampleItemService) {}

  @Post()
  @Access.user()
  @ApiOperation({ summary: 'Create a sample item owned by the signed-in user' })
  @ApiResponse({ status: 201, standardSchema: SampleItemView })
  @ApiResponse({
    status: 409,
    description: 'You already have one with this name (SAMPLE_ITEM_NAME_TAKEN)',
    standardSchema: ProblemDetails,
  })
  async create(
    @Body({ schema: CreateSampleItemBody }) body: z.output<typeof CreateSampleItemBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const view = toSampleItemView(await this.sampleItems.create(currentUser(), body));
    void reply.header('location', `/v1/sample-items/${view.id}`);
    return view;
  }

  @Get()
  @Access.user()
  @ApiOperation({ summary: 'List your sample items (everyone’s for admins), newest first' })
  @ApiResponse({ status: 200, standardSchema: SampleItemPage })
  async list(@Query({ schema: PageQuery }) query: z.output<typeof PageQuery>) {
    const actor = currentUser();
    // The token is bound to the caller, so no one else can replay it.
    const paging = keysetPaging(query, { userId: actor.userId });
    const page = await this.sampleItems.list(actor, paging.request);
    return { items: page.items.map(toSampleItemView), nextPageToken: paging.next(page) };
  }

  @Get(':id')
  @Access.user()
  @ApiOperation({ summary: 'Get one of your sample items' })
  @ApiResponse({ status: 200, standardSchema: SampleItemView })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async get(@Param('id', { schema: IdParam }) id: string) {
    return toSampleItemView(await this.sampleItems.get(currentUser(), id));
  }

  @Patch(':id')
  @Access.user()
  @ApiOperation({ summary: 'Change one of your sample items (only the fields that are sent)' })
  @ApiResponse({ status: 200, standardSchema: SampleItemView })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async update(
    @Param('id', { schema: IdParam }) id: string,
    @Body({ schema: UpdateSampleItemBody }) body: z.output<typeof UpdateSampleItemBody>,
  ) {
    return toSampleItemView(await this.sampleItems.update(currentUser(), id, body));
  }

  @Delete(':id')
  @Access.user()
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete one of your sample items' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async remove(@Param('id', { schema: IdParam }) id: string): Promise<void> {
    await this.sampleItems.delete(currentUser(), id);
  }
}
