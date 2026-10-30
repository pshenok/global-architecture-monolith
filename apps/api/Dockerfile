# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker build -f apps/api/Dockerfile -t gam-api .
# Migrations are a separate release step: run `node dist/migrate.js` with the same image.

FROM node:26-trixie-slim AS build
RUN npm install --global pnpm@12.15.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm turbo run build --filter "@gam/api..." \
 && pnpm --filter "@gam/api" deploy --prod --legacy /out

# Distroless: no shell, no package manager, non-root (uid 65532).
FROM gcr.io/distroless/nodejs26-debian13:nonroot
WORKDIR /app
COPY --from=build /out .
# Behind a TLS-terminating proxy or ingress set TLS_ENABLED=false; otherwise mount a
# certificate and set TLS_CERT_FILE and TLS_KEY_FILE (read at start: roll to renew).
ENV NODE_ENV=production HTTP_HOST=0.0.0.0 HTTP_PORT=8443
EXPOSE 8443
# Probes: HTTP GET /healthz (liveness) and /readyz (readiness).
CMD ["--enable-source-maps", "--import", "@gam/platform/telemetry", "dist/main.js"]
