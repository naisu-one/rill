import { Hono } from 'hono';
import { swaggerUI } from '@hono/swagger-ui';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';
import { config } from './core/config';
import { errorHandler } from './core/errors';
import { apiRouter } from './http/routes/api.routes';
import { oauthRouter } from './http/routes/oauth.routes';
import { mcpRouter } from './http/routes/mcp.routes';
import { buildOpenApiDocument } from './http/openapi';

const app = new Hono();

// Global Middlewares
app.use('*', logger());
// Public, keyless API consumed by agents/MCP clients from anywhere → wildcard origin, NO credentials
// (wildcard + credentials is invalid per the CORS spec and rejected by browsers).
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    // `Authorization` is required for the OAuth-protected `/mcp` endpoint, and `MCP-Protocol-Version`
    // is sent by MCP clients on every call — omitting either makes the browser preflight fail before
    // the request is ever seen here, which looks like an unreachable server rather than a CORS
    // rejection. `WWW-Authenticate` must be EXPOSED (not merely allowed): it carries the discovery
    // pointer a client reads off a 401 to find the authorization server, and an unexposed response
    // header is invisible to browser JavaScript.
    allowHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version'],
    exposeHeaders: ['WWW-Authenticate', 'MCP-Protocol-Version'],
    maxAge: 600,
  }),
);
// Cap request bodies — flows/PTBs are small; reject oversized payloads early (DoS guard).
app.use(
  '*',
  bodyLimit({
    maxSize: 512 * 1024,
    onError: (c) =>
      c.json({ success: false, error: 'Request body too large (max 512KB).' }, 413),
  }),
);

const swagger = swaggerUI({ url: '/api/openapi.json' });

app.get('/health', (c) =>
  c.json({
    name: 'Rill Bun-Hono API',
    status: 'healthy',
    version: '1.0.0',
    network: config.network,
    apiBase: `${config.publicBaseUrl}/api`,
    docs: config.publicBaseUrl,
    keyless: true,
    agentWalletConfigured: Boolean(config.agentWallet),
    /** The single URL a user pastes into their agent, plus whether issued tokens survive a restart
     *  (they do not when `RILL_OAUTH_SECRET` is unset — see `core/config.ts`). */
    mcp: {
      endpoint: config.oauth.resource,
      auth: 'oauth2.1+pkce+dcr',
      tokensDurable: config.oauth.secretFromEnv,
    },
    walrus: {
      readEndpoint: '/api/audit/:blobId',
      availability: 'unchecked',
      uploadsEnabled: false,
    },
    description:
      'Keyless Move flow compiler for Sui - builds and simulates unsigned PTBs; signing is local.',
  }),
);

app.get('/', swagger);
app.get('/api/docs', swagger);

app.get('/api/openapi.json', (c) => c.json(buildOpenApiDocument(config.publicBaseUrl)));

app.route('/api', apiRouter);

// Mounted at the ORIGIN ROOT, not under `/api`. RFC 8414/9728 define the `/.well-known/*` discovery
// paths as origin-relative and every MCP client probes them there, so a prefixed mount would be
// invisible to all of them. `/mcp` sits at the root for the same reason: it is the single URL a
// user pastes into their agent, and short URLs get pasted correctly more often than long ones.
app.route('/', oauthRouter);
app.route('/', mcpRouter);

// Global Error Handler
app.onError(errorHandler);

// Export app type for Hono RPC Client usage in Frontend
export type AppType = typeof app;

// Bun entry point configuration
export default {
  port: config.port,
  fetch: app.fetch,
};
