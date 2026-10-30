import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:http2';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IdentityActor } from '@gam/kernel';
import { Body, Controller, Get, Injectable, Module, Post } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Access } from '../src/auth/access.ts';
import { IdentityResolver, type ResolvedUser } from '../src/auth/identity-resolver.ts';
import { PLATFORM_MIGRATIONS } from '../src/database/platform-migrations.ts';
import { createTestApp, type TestApp } from '../src/testing/test-app.ts';
import { createTestDatabase, type TestDatabase } from '../src/testing/test-database.ts';

const USER_ID = '01900000-0000-7000-8000-000000000001';
const DEADLINE_MS = 300;

/** A throwaway self-signed certificate for 127.0.0.1, made with openssl like `pnpm certs`. */
function selfSignedCertificate(dir: string): { cert: string; key: string } {
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      '/CN=localhost',
      '-days',
      '1',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  return { cert, key };
}

interface Http2Outcome {
  status: number;
  contentType: string;
  body: string;
  /** RST_STREAM code the stream closed with (0 = NO_ERROR, also for a normal end). */
  rstCode: number | undefined;
}

/**
 * One HTTP/2 request. With `partialBody`, sends that much of a larger body and never
 * finishes it, the way a stalled upload looks to the server.
 */
function http2Call(
  origin: string,
  ca: Buffer,
  headers: Record<string, string>,
  partialBody?: string,
): Promise<Http2Outcome> {
  return new Promise((resolve, reject) => {
    const session = connect(origin, { ca });
    session.on('error', reject);
    const stream = session.request(headers, { endStream: false });
    const outcome: Http2Outcome = { status: 0, contentType: '', body: '', rstCode: undefined };
    stream.setEncoding('utf8');
    stream.on('response', (response) => {
      outcome.status = Number(response[':status']);
      outcome.contentType = String(response['content-type'] ?? '');
    });
    stream.on('data', (chunk: string) => {
      outcome.body += chunk;
    });
    stream.on('close', () => {
      outcome.rstCode = stream.rstCode;
      session.close();
      resolve(outcome);
    });
    stream.on('error', () => undefined);
    if (partialBody === undefined) stream.end();
    else stream.write(partialBody);
  });
}

/** Identity lookups take longer than the deadline. */
@Injectable()
class SlowResolver extends IdentityResolver {
  calls = 0;

  async resolve(_identity: IdentityActor): Promise<ResolvedUser | null> {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS * 2));
    return { userId: USER_ID, roles: [] };
  }
}

/** Routes that never answer, and one that records whether it ran at all. */
@Controller('slow')
class SlowController {
  ran = 0;

  @Get('catalogue')
  @Access.public('deadline tests')
  catalogue() {
    return new Promise(() => undefined);
  }

  @Post('upload')
  @Access.public('deadline tests')
  upload(@Body() _body: unknown) {
    this.ran += 1;
    return new Promise(() => undefined);
  }

  @Get('me')
  @Access.user()
  me() {
    this.ran += 1;
    return { ok: true };
  }
}

@Module({ controllers: [SlowController], providers: [SlowResolver], exports: [SlowResolver] })
class SlowModule {}

describe('request deadline (REQUEST_TIMEOUT_MS)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gam-tls-'));
  const { cert, key } = selfSignedCertificate(dir);
  const ca = readFileSync(cert);
  let db: TestDatabase;
  let api: TestApp;
  let origin: string;

  beforeAll(async () => {
    db = await createTestDatabase({ migrations: [PLATFORM_MIGRATIONS] });
    api = await createTestApp({
      database: db,
      modules: [SlowModule],
      identities: { imports: [SlowModule], useExisting: SlowResolver },
      env: {
        TLS_ENABLED: 'true',
        TLS_CERT_FILE: cert,
        TLS_KEY_FILE: key,
        REQUEST_TIMEOUT_MS: String(DEADLINE_MS),
      },
    });
    await api.app.listen({ host: '127.0.0.1', port: 0 });
    origin = `https://127.0.0.1:${(api.app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await api?.close();
    await db?.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers 504 REQUEST_TIMEOUT over HTTP/2 with TLS, where requestTimeout does not apply', async () => {
    const started = Date.now();
    const response = await http2Call(origin, ca, { ':method': 'GET', ':path': '/slow/catalogue' });
    expect(response.status).toBe(504);
    expect(response.contentType).toMatch(/^application\/problem\+json/);
    expect(JSON.parse(response.body)).toMatchObject({ status: 504, code: 'REQUEST_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('applies the same deadline to requests that never touch the socket layer', async () => {
    const response = await api.inject({ method: 'GET', url: '/slow/catalogue' });
    expect(response.statusCode).toBe(504);
    expect(response.json().code).toBe('REQUEST_TIMEOUT');
  });

  it('never starts the controller once the deadline passed during the guards', async () => {
    const controller = api.get(SlowController);
    const resolver = api.get(SlowResolver);
    const before = controller.ran;
    const headers = await api.bearer('slow-login');
    const response = await api.inject({ method: 'GET', url: '/slow/me', headers });
    expect(response.statusCode).toBe(504);
    // The identity lookup finishes after the answer; the controller must not run after it.
    await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS * 3));
    expect(resolver.calls).toBeGreaterThan(0);
    expect(controller.ran).toBe(before);
  });

  it('stops a stalled HTTP/2 upload with RST_STREAM(NO_ERROR) after the 504', async () => {
    const controller = api.get(SlowController);
    const before = controller.ran;
    const response = await http2Call(
      origin,
      ca,
      {
        ':method': 'POST',
        ':path': '/slow/upload',
        'content-type': 'application/json',
        'content-length': '1000',
      },
      '{"title":"',
    );
    expect(response.status).toBe(504);
    expect(JSON.parse(response.body).code).toBe('REQUEST_TIMEOUT');
    // Closed by the server although the client never finished its body.
    expect(response.rstCode).toBe(0);
    expect(controller.ran).toBe(before);
  });

  it('closes a stalled HTTP/1.1 upload over TLS after the 504', async () => {
    const outcome = await new Promise<{ status: number; connection: string | undefined }>(
      (resolve, reject) => {
        const call = httpsRequest(`${origin}/slow/upload`, {
          method: 'POST',
          ca,
          headers: { 'content-type': 'application/json', 'content-length': '1000' },
        });
        call.on('error', () => undefined);
        call.on('response', (response) => {
          response.resume();
          // The server ends the connection although the body was never finished.
          call.socket?.once('close', () =>
            resolve({ status: response.statusCode ?? 0, connection: response.headers.connection }),
          );
        });
        call.on('close', () => undefined);
        call.write('{"title":"', (error) => error && reject(error));
      },
    );
    expect(outcome.status).toBe(504);
    expect(outcome.connection).toBe('close');
  });
});
