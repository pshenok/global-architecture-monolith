import { configureApp, createAdapter, parseConfig } from '@gam/platform';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.ts';
import { ConfigSchema } from './config.ts';

const config = parseConfig(ConfigSchema);
const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAdapter(config), {
  bufferLogs: true,
});
configureApp(app, config);
await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
const scheme = config.TLS_ENABLED ? 'https' : 'http';
app
  .get(Logger)
  .log(`api listening on ${scheme}://${config.HTTP_HOST}:${config.HTTP_PORT} (docs: /docs)`);
