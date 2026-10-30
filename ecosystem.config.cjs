// PM2 definition of the local stack, generated from modules.json.
// CommonJS on purpose: PM2 require()s this file.
//   pnpm stack:up      build, migrate, start everything, wait until ready
//   pnpm stack:status  pnpm stack:logs   pnpm stack:down
const registry = require('./modules.json');

const CERTS = `${__dirname}/.certs`;

/** The local OIDC provider (tools/dev-idp.ts) the API trusts; dev only. */
const devIdp = `http://127.0.0.1:${registry.devIdp.port}`;
const AUTH_ISSUERS = JSON.stringify([
  {
    issuer: devIdp,
    audience: 'gam-api',
    jwksUri: `${devIdp}/jwks.json`,
    userinfoUri: `${devIdp}/userinfo`,
  },
]);

const common = {
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  max_restarts: 10,
  min_uptime: 5000,
  kill_timeout: 15000,
  merge_logs: true,
  time: false,
  // The repo's pinned Node (devEngines.runtime, linked by pnpm), not whatever is on PATH.
  // (The symlink path matters: PM2 treats an "@" in the interpreter path as an nvm version.)
  interpreter: `${__dirname}/node_modules/.bin/node`,
  node_args: [
    '--enable-source-maps',
    '--env-file-if-exists=.env',
    '--import',
    '@gam/platform/telemetry',
  ],
};

module.exports = {
  apps: [
    {
      ...common,
      // Prefixed: PM2 is per user, and other stacks may run next to this one.
      name: 'gam-api',
      cwd: `${__dirname}/${registry.api.dir}`,
      script: 'dist/main.js',
      env: {
        NODE_ENV: 'development',
        LOG_PRETTY: 'false',
        HTTP_HOST: '127.0.0.1',
        HTTP_PORT: String(registry.api.httpsPort),
        TLS_ENABLED: 'true',
        TLS_CERT_FILE: `${CERTS}/dev-cert.pem`,
        TLS_KEY_FILE: `${CERTS}/dev-key.pem`,
        DATABASE_URL: `postgresql://gam:gam@localhost:5432/${registry.api.database}`,
        AUTH_ISSUERS,
        // Rotation tests rotate the dev IdP's key and use the new one right away.
        AUTH_JWKS_UNKNOWN_KID_COOLDOWN_S: '1',
        OTEL_SERVICE_NAME: 'gam-api',
      },
    },
    {
      ...common,
      name: 'gam-dev-idp',
      cwd: __dirname,
      script: 'tools/dev-idp.ts',
      node_args: ['--enable-source-maps'],
      env: { NODE_ENV: 'development' },
    },
  ],
};
