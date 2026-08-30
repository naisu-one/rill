import { Hono, type Context } from 'hono';
import { config } from '../../core/config';
import {
  authorizationServerMetadata,
  authorizeErrorRedirect,
  beginAuthorization,
  beginWalletChallenge,
  completeWalletChallenge,
  completeConsent,
  consentPrompt,
  exchangeToken,
  OAuthError,
  protectedResourceMetadata,
  registerClient,
  revokeToken,
} from '../../features/auth/oauth.service';
import { SignInError } from '../../features/auth/siws';

/**
 * OAuth 2.1 authorization-server routes, mounted at the ORIGIN ROOT rather than under `/api`.
 *
 * The `/.well-known/*` paths are not a stylistic choice: RFC 8414 and RFC 9728 define them as
 * origin-relative, and MCP clients (Claude, ChatGPT, VS Code) probe exactly those URLs. Serving
 * them at `/api/.well-known/...` would be invisible to every one of them, and the failure would
 * look like "the connector just doesn't work" with nothing in the logs to explain why.
 *
 * The `/oauth/*` endpoints sit at the root for the same reason the metadata points at them there.
 */
export const oauthRouter = new Hono();

/** Both spellings of each metadata path. The base form is what RFC 8414/9728 define; the
 *  `/mcp`-suffixed form is what a client derives from a resource URL with a path component, and
 *  different MCP clients probe different ones. Serving both costs two lines and removes a whole
 *  class of "discovery silently failed" support tickets. */
const AS_METADATA_PATHS = ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'];
const PR_METADATA_PATHS = ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'];

for (const path of AS_METADATA_PATHS) {
  oauthRouter.get(path, (c) => c.json(authorizationServerMetadata()));
}
for (const path of PR_METADATA_PATHS) {
  oauthRouter.get(path, (c) => c.json(protectedResourceMetadata()));
}

/** Map an `OAuthError` to the JSON error body OAuth defines (RFC 6749 §5.2). */
function oauthErrorJson(err: OAuthError) {
  return { error: err.code, error_description: err.description };
}

/**
 * A minimal HTML page for authorize-time failures that must NOT be redirected back to the client
 * (an unknown `client_id`, a `redirect_uri` that doesn't match). A browser is the caller here, so a
 * bare JSON body would render as unexplained text; this at least tells the user what to do next.
 */
function authorizeErrorPage(err: OAuthError): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string
  ));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>Rill — sign-in failed</title>`
    + `<style>body{font:16px/1.6 system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;`
    + `display:grid;place-items:center;background:#0b0b0f;color:#e8e8ef}main{max-width:34rem;padding:2rem}`
    + `code{background:#1b1b24;padding:.15em .4em;border-radius:.3em;font-size:.9em}`
    + `h1{font-size:1.25rem;margin:0 0 .75rem}p{color:#a9a9b8;margin:.5rem 0}</style></head>`
    + `<body><main><h1>Rill could not start this sign-in</h1>`
    + `<p>${escape(err.description)}</p>`
    + `<p>Error code: <code>${escape(err.code)}</code></p>`
    + `<p>Remove the Rill connector in your agent and add it again — the agent registers itself on `
    + `each connect, so a stale registration is fixed by re-adding it.</p></main></body></html>`;
}

// ── dynamic client registration (RFC 7591) ──

oauthRouter.post('/oauth/register', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_client_metadata', error_description: 'Body must be JSON.' }, 400);
  }
  try {
    // 201 Created is what RFC 7591 §3.2.1 specifies; some clients check for it explicitly.
    return c.json(registerClient(body), 201);
  } catch (err) {
    if (err instanceof OAuthError) return c.json(oauthErrorJson(err), err.status as 400);
    console.error('[oauth] registration failed:', err);
    return c.json({ error: 'invalid_client_metadata', error_description: 'Registration failed.' }, 400);
  }
});

// ── authorization endpoint ──

oauthRouter.get('/oauth/authorize', (c) => {
  const query = c.req.query();
  try {
    const { consentUrl } = beginAuthorization(query);
    // 302 to Rill Studio, which runs wallet-connect and posts the signature back. The authorization
    // server itself renders no consent UI — the wallet is the consent UI.
    return c.redirect(consentUrl, 302);
  } catch (err) {
    if (err instanceof OAuthError) {
      // Redirect the error back to the client ONLY once the redirect_uri has been validated;
      // `redirectable` is false for exactly the failures where it has not been.
      if (err.redirectable && typeof query.redirect_uri === 'string') {
        return c.redirect(authorizeErrorRedirect(query.redirect_uri, err, query.state), 302);
      }
      return c.html(authorizeErrorPage(err), err.status as 400);
    }
    console.error('[oauth] authorize failed:', err);
    return c.html(
      authorizeErrorPage(new OAuthError('server_error', 'Something went wrong starting this sign-in.', 500)),
      500,
    );
  }
});

/** What Rill Studio's consent page reads to know who is asking and what to sign. */
oauthRouter.get('/oauth/consent/:requestId', (c) => {
  try {
    return c.json({ success: true, data: consentPrompt(c.req.param('requestId')) });
  } catch (err) {
    if (err instanceof OAuthError) return c.json(oauthErrorJson(err), err.status as 400);
    console.error('[oauth] consent prompt failed:', err);
    return c.json({ error: 'server_error', error_description: 'Could not load this sign-in request.' }, 500);
  }
});

/** Studio posts the wallet signature here; the response carries where to send the browser next. */
oauthRouter.post('/oauth/consent', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', error_description: 'Body must be JSON.' }, 400);
  }
  try {
    const { redirectTo, address } = await completeConsent(body as Record<string, unknown>);
    return c.json({ success: true, data: { redirectTo, address } });
  } catch (err) {
    if (err instanceof OAuthError) return c.json(oauthErrorJson(err), err.status as 400);
    if (err instanceof SignInError) {
      return c.json({ error: 'access_denied', error_description: err.message }, 400);
    }
    console.error('[oauth] consent failed:', err);
    return c.json({ error: 'server_error', error_description: 'Could not complete this sign-in.' }, 500);
  }
});

// ── token endpoint ──

/**
 * Read a token-endpoint body. `application/x-www-form-urlencoded` is what RFC 6749 §4.1.3 mandates
 * and what every real client sends; JSON is accepted too because some agent runtimes send it and
 * failing them over a content type would be a pointless incompatibility.
 */
async function readTokenForm(c: Context): Promise<Record<string, string>> {
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const json = (await c.req.json()) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(json).filter(([, v]) => typeof v === 'string') as [string, string][],
    );
  }
  const form = await c.req.parseBody();
  return Object.fromEntries(
    Object.entries(form).filter(([, v]) => typeof v === 'string') as [string, string][],
  );
}

oauthRouter.post('/oauth/token', async (c) => {
  let form: Record<string, string>;
  try {
    form = await readTokenForm(c);
  } catch {
    return c.json({ error: 'invalid_request', error_description: 'Could not parse the request body.' }, 400);
  }
  try {
    const tokens = exchangeToken(form);
    // Tokens must never be cached by an intermediary (RFC 6749 §5.1).
    return c.json(tokens, 200, { 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  } catch (err) {
    if (err instanceof OAuthError) {
      return c.json(oauthErrorJson(err), err.status as 400, { 'Cache-Control': 'no-store' });
    }
    console.error('[oauth] token exchange failed:', err);
    return c.json({ error: 'server_error', error_description: 'Token exchange failed.' }, 500);
  }
});

/** RFC 7009. Always 200 — a distinguishable failure would let a caller probe token validity. */
oauthRouter.post('/oauth/revoke', async (c) => {
  try {
    revokeToken(await readTokenForm(c));
  } catch {
    // Deliberately ignored, per the note above.
  }
  return c.body(null, 200);
});

// ── Studio wallet session ──

/**
 * First-party sign-in for Rill Studio: one challenge, one signature, one short-lived access token.
 * Deliberately separate from `/oauth/authorize` — see `completeWalletChallenge` for why a
 * first-party page with the wallet already connected does not need the redirect dance.
 */
oauthRouter.get('/oauth/wallet-challenge', (c) => {
  return c.json({ success: true, data: beginWalletChallenge() }, 200, { 'Cache-Control': 'no-store' });
});

oauthRouter.post('/oauth/wallet-token', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', error_description: 'Body must be JSON.' }, 400);
  }
  try {
    const data = await completeWalletChallenge(body as Record<string, unknown>);
    return c.json({ success: true, data }, 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    if (err instanceof OAuthError) return c.json(oauthErrorJson(err), err.status as 400);
    if (err instanceof SignInError) {
      return c.json({ error: 'access_denied', error_description: err.message }, 400);
    }
    console.error('[oauth] wallet sign-in failed:', err);
    return c.json({ error: 'server_error', error_description: 'Could not complete this sign-in.' }, 500);
  }
});
