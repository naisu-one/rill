import { Hono, type Context } from 'hono';
import { config } from '../../core/config';
import {
  authenticateAccessToken,
  OAuthError,
  wwwAuthenticateHeader,
} from '../../features/auth/oauth.service';
import { bearerFromHeader } from '../../features/auth/tokens';
import { dispatchMcpPayload, MCP_PARSE_ERROR_BODY } from '../mcp-transport';

/**
 * The single, owner-scoped MCP endpoint: `POST /mcp`.
 *
 * This is the one URL a user pastes into their agent. It replaces the per-skill
 * `/api/mcp/:skillId` model for anyone signed in — one connector serves every action that user has
 * published, and adding an action later needs no reconnection. The old endpoint stays exactly as it
 * was for already-shared links and for the local Claude Code / OpenCode setup.
 *
 * Authentication is an OAuth 2.1 bearer token whose subject is a Sui address (see
 * `features/auth/`). Every 401 carries `WWW-Authenticate` with a pointer to the protected-resource
 * metadata, which is what lets an MCP client discover the authorization server and start the flow
 * on its own instead of surfacing a dead connector to the user.
 */
export const mcpRouter = new Hono();

/** 401 body + the discovery header. Kept in one place so no path can answer 401 without it. */
function unauthorized(c: Context, err: OAuthError) {
  return c.json(
    { error: err.code, error_description: err.description },
    err.status as 401,
    { 'WWW-Authenticate': wwwAuthenticateHeader(err.description) },
  );
}

/**
 * A browser landing on the endpoint gets the human docs; an MCP client probing for a server-push
 * stream gets 405 (this server never pushes, and the SDK handles that answer). Same convention the
 * per-skill endpoint already uses — deliberately BEFORE any auth check, because neither response
 * reveals anything and making discovery require a token is how a connector becomes unaddable.
 */
mcpRouter.get('/mcp', (c) => {
  if ((c.req.header('Accept') || '').includes('text/event-stream')) {
    return c.text('This MCP server does not support a GET event stream.', 405);
  }
  return c.redirect(`${config.publicBaseUrl}/api/docs`, 302);
});

mcpRouter.post('/mcp', async (c) => {
  let caller: { address: string };
  try {
    caller = authenticateAccessToken(bearerFromHeader(c.req.header('Authorization')));
  } catch (err) {
    if (err instanceof OAuthError) return unauthorized(c, err);
    console.error('[mcp] authentication failed:', err);
    return unauthorized(c, new OAuthError('invalid_token', 'Authentication failed.', 401));
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(MCP_PARSE_ERROR_BODY, 400);
  }

  const result = await dispatchMcpPayload({ kind: 'owner', address: caller.address }, body);
  if (result.status === 202) return c.body(null, 202);
  return c.json(result.body, result.status);
});
