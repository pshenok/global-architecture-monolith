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
import { HouseService } from '../../application/house.service.ts';
import {
  CreateHouseBody,
  HousePage,
  HouseQuery,
  HouseView,
  toHouseView,
  UpdateHouseBody,
} from './houses.schemas.ts';

const ListHousesQuery = PageQuery.extend(HouseQuery.shape);

/** HTTP adapter of the houses module: validate, call one use case, map the result. */
@ApiTags('houses')
@ApiResponse({ status: 400, description: 'Invalid input', standardSchema: ProblemDetails })
@Controller('v1/houses')
export class HousesController {
  constructor(private readonly houses: HouseService) {}

  @Post()
  @Access.user()
  @ApiOperation({ summary: 'List a house; the signed-in user becomes its owner' })
  @ApiResponse({ status: 201, standardSchema: HouseView })
  async create(
    @Body({ schema: CreateHouseBody }) body: z.output<typeof CreateHouseBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const view = toHouseView(await this.houses.create(currentUser(), body));
    void reply.header('location', `/v1/houses/${view.id}`);
    return view;
  }

  @Get()
  @Access.public('world-readable catalogue')
  @ApiOperation({ summary: 'List houses, newest first, optionally by owner or city' })
  @ApiResponse({ status: 200, standardSchema: HousePage })
  async list(@Query({ schema: ListHousesQuery }) query: z.output<typeof ListHousesQuery>) {
    const filter = { ownerId: query.ownerId, city: query.city };
    const paging = keysetPaging(query, filter);
    const page = await this.houses.list(filter, paging.request);
    return { items: page.items.map(toHouseView), nextPageToken: paging.next(page) };
  }

  @Get(':id')
  @Access.public('world-readable catalogue')
  @ApiOperation({ summary: 'Get a house' })
  @ApiResponse({ status: 200, standardSchema: HouseView })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async get(@Param('id', { schema: IdParam }) id: string) {
    return toHouseView(await this.houses.get(id));
  }

  @Patch(':id')
  @Access.user()
  @ApiOperation({ summary: 'Change your house (only the fields that are sent)' })
  @ApiResponse({ status: 200, standardSchema: HouseView })
  @ApiResponse({ status: 403, description: 'Not your house', standardSchema: ProblemDetails })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async update(
    @Param('id', { schema: IdParam }) id: string,
    @Body({ schema: UpdateHouseBody }) body: z.output<typeof UpdateHouseBody>,
  ) {
    return toHouseView(await this.houses.update(currentUser(), id, body));
  }

  @Delete(':id')
  @Access.user()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete your house',
    description: 'Its upcoming and ongoing stays are cancelled within seconds.',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 403, description: 'Not your house', standardSchema: ProblemDetails })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async remove(@Param('id', { schema: IdParam }) id: string): Promise<void> {
    await this.houses.delete(currentUser(), id);
  }
}
