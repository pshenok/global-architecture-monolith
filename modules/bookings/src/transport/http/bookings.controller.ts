import {
  Access,
  currentUser,
  IdParam,
  keysetPaging,
  PageQuery,
  ProblemDetails,
} from '@gam/platform';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { BookingService } from '../../application/booking.service.ts';
import {
  BookingPage,
  BookingQuery,
  BookingView,
  CreateBookingBody,
  toBookingView,
} from './bookings.schemas.ts';

const ListBookingsQuery = PageQuery.extend(BookingQuery.shape);

/** HTTP adapter of the bookings module: validate, call one use case, map the result. */
@ApiTags('bookings')
@ApiResponse({
  status: 400,
  description: 'Invalid input or failed precondition',
  standardSchema: ProblemDetails,
})
@Controller('v1/bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingService) {}

  @Post()
  @Access.user()
  @ApiOperation({ summary: 'Book a house for a date range' })
  @ApiResponse({ status: 201, standardSchema: BookingView })
  @ApiResponse({
    status: 409,
    description: 'Dates overlap a confirmed booking (BOOKING_DATES_UNAVAILABLE)',
    standardSchema: ProblemDetails,
  })
  async create(
    @Body({ schema: CreateBookingBody }) body: z.output<typeof CreateBookingBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const view = toBookingView(await this.bookings.create(currentUser(), body));
    void reply.header('location', `/v1/bookings/${view.id}`);
    return view;
  }

  @Get()
  @Access.user()
  @ApiOperation({ summary: 'List your bookings (as guest or host), newest first' })
  @ApiResponse({ status: 200, standardSchema: BookingPage })
  async list(@Query({ schema: ListBookingsQuery }) query: z.output<typeof ListBookingsQuery>) {
    const actor = currentUser();
    const filter = { houseId: query.houseId };
    // The token is bound to the caller and the party too, so no one else can replay it.
    const paging = keysetPaging(query, { ...filter, party: query.as, userId: actor.userId });
    const page = await this.bookings.list(actor, query.as, filter, paging.request);
    return { items: page.items.map(toBookingView), nextPageToken: paging.next(page) };
  }

  @Get(':id')
  @Access.user()
  @ApiOperation({ summary: 'Get a booking (its guest, its host or an admin)' })
  @ApiResponse({ status: 200, standardSchema: BookingView })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async get(@Param('id', { schema: IdParam }) id: string) {
    return toBookingView(await this.bookings.get(currentUser(), id));
  }

  @Post(':id/cancel')
  @Access.user()
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a booking and free its dates' })
  @ApiResponse({ status: 200, standardSchema: BookingView })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async cancel(@Param('id', { schema: IdParam }) id: string) {
    return toBookingView(await this.bookings.cancel(currentUser(), id));
  }
}
