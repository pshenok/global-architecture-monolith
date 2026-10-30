import {
  Access,
  currentIdentity,
  currentUser,
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
import { UserService } from '../../application/user.service.ts';
import {
  RegisterUserBody,
  toUserView,
  UpdateUserBody,
  UserIdParam,
  UserPage,
  UserView,
} from './users.schemas.ts';

/** `me` -> the signed-in user's id. */
const userId = (id: string) => (id === 'me' ? currentUser().userId : id);

/**
 * HTTP adapter of the users module: validate the request, call one use case with the
 * acting user, map the result. No business logic here; DomainErrors become problem
 * details in the platform's filter.
 */
@ApiTags('users')
@ApiResponse({ status: 400, description: 'Invalid input', standardSchema: ProblemDetails })
@Controller('v1/users')
export class UsersController {
  constructor(private readonly users: UserService) {}

  @Post()
  @Access.identity()
  @ApiOperation({
    summary: 'Register the signed-in login as a new user',
    description: 'The email comes from the identity provider (per its email policy).',
  })
  @ApiResponse({ status: 201, standardSchema: UserView })
  @ApiResponse({
    status: 403,
    description: 'The identity provider has not verified an email (EMAIL_NOT_VERIFIED)',
    standardSchema: ProblemDetails,
  })
  @ApiResponse({
    status: 409,
    description: 'Already registered (USER_ALREADY_REGISTERED) or email taken (USER_EMAIL_TAKEN)',
    standardSchema: ProblemDetails,
  })
  async register(
    @Body({ schema: RegisterUserBody }) body: z.output<typeof RegisterUserBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const view = toUserView(await this.users.register(currentIdentity(), body));
    void reply.header('location', `/v1/users/${view.id}`);
    return view;
  }

  @Get()
  @Access.admin()
  @ApiOperation({ summary: 'List users, newest first (admins only)' })
  @ApiResponse({ status: 200, standardSchema: UserPage })
  async list(@Query({ schema: PageQuery }) query: z.output<typeof PageQuery>) {
    const paging = keysetPaging(query);
    const page = await this.users.list(currentUser(), paging.request);
    return { items: page.items.map(toUserView), nextPageToken: paging.next(page) };
  }

  @Get(':id')
  @Access.user()
  @ApiOperation({ summary: 'Get a user: yourself (`me`), or anyone if you are an admin' })
  @ApiResponse({ status: 200, standardSchema: UserView })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async get(@Param('id', { schema: UserIdParam }) id: string) {
    return toUserView(await this.users.get(currentUser(), userId(id)));
  }

  @Patch(':id')
  @Access.user()
  @ApiOperation({ summary: 'Change a user (only the fields that are sent)' })
  @ApiResponse({ status: 200, standardSchema: UserView })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async update(
    @Param('id', { schema: UserIdParam }) id: string,
    @Body({ schema: UpdateUserBody }) body: z.output<typeof UpdateUserBody>,
  ) {
    return toUserView(await this.users.update(currentUser(), userId(id), body));
  }

  @Delete(':id')
  @Access.user()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a user and its logins',
    description: 'Its houses and its open stays as a guest are cleaned up within seconds.',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async remove(@Param('id', { schema: UserIdParam }) id: string): Promise<void> {
    await this.users.delete(currentUser(), userId(id));
  }
}
