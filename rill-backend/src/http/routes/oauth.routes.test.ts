import { beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { config } from '../../core/config';
import { oauthStore } from '../../features/auth/oauth.store';
import { mcpRouter } from './mcp.routes';
import { oauthRouter } from './oauth.routes';

/**
 * End-to-end over HTTP: the exact sequence an MCP client performs when a user pastes the Rill URL
 * into their agent and presses Add. These are wiring tests — `oauth.service.test.ts` covers the
 * protocol rules themselves — but the wiring is where this feature actually fails in practice: a
 * metadata document served under the wrong prefix, or a 401 missing `WWW-Authenticate`, produces a
 * connector that silently never works and logs nothing useful.
 */
const app = new Hono().route('/', oauthRouter).route('/', mcpRouter);

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'test-verifier-0123456789-0123456789-0123456789';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

beforeEach(() => {
  oauthStore.resetForTests();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

/** Register a client and complete the browser half with a real wallet key. */
async function connect(keypair = new Ed25519Keypair()) {
  const client = await (await post('/oauth/register', {
    redirect_uris: [REDIRECT],
    client_name: 'Claude',
  })).json() as { client_id: string };

  const authorize = await app.request(
    `/oauth/authorize?response_type=code&client_id=${client.client_id}`
      + `&redirect_uri=${encodeURIComponent(REDIRECT)}`
      + `&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=st`,
  );
  const requestId = new URL(authorize.headers.get('location')!).searchParams.get('request')!;

  const prompt = await (await app.request(`/oauth/consent/${requestId}`)).json() as {
    data: { message: string };
  };
  const { signature } = await keypair.signPersonalMessage(
    new TextEncoder().encode(prompt.data.message),
  );
  const consent = await (await post('/oauth/consent', { requestId, signature })).json() as {
    data: { redirectTo: string };
  };
  const code = new URL(consent.data.redirectTo).searchParams.get('code')!;

  // The token endpoint is exercised with form encoding, which is what RFC 6749 mandates and what
  // every real client sends — JSON here would test a path clients do not take.
  const tokens = await (await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    }).toString(),
  })).json() as { access_token: string; refresh_token: string; token_type: string };

  return { client, tokens, keypair };
}

test('protected-resource metadata is served at both paths a client may probe', async () => {
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: config.oauth.resource,
      authorization_servers: [config.publicBaseUrl],
    });
  }
});

test('authorization-server metadata advertises registration and S256 PKCE', async () => {
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp']) {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      registration_endpoint: `${config.publicBaseUrl}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  }
});

// Without this header the client has no way to discover where to authenticate, and the connector
// simply appears broken.
test('an unauthenticated /mcp call is 401 and points at the discovery document', async () => {
  const response = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  expect(response.status).toBe(401);
  const header = response.headers.get('WWW-Authenticate') ?? '';
  expect(header).toContain('Bearer');
  expect(header).toContain('/.well-known/oauth-protected-resource');
});

test('a garbage bearer token is refused the same way a missing one is', async () => {
  const response = await post(
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { Authorization: 'Bearer not-a-real-token' },
  );
  expect(response.status).toBe(401);
  expect(response.headers.get('WWW-Authenticate')).toContain('Bearer');
});

test('dynamic registration returns 201 and a client id, with no secret', async () => {
  const response = await post('/oauth/register', { redirect_uris: [REDIRECT], client_name: 'Claude' });
  expect(response.status).toBe(201);
  const body = await response.json() as Record<string, unknown>;
  expect(body.client_id).toMatch(/^rill_client_/);
  expect(body).not.toHaveProperty('client_secret');
});

test('authorize redirects the browser to Studio carrying the request id', async () => {
  const client = await (await post('/oauth/register', { redirect_uris: [REDIRECT] })).json() as { client_id: string };
  const response = await app.request(
    `/oauth/authorize?response_type=code&client_id=${client.client_id}`
      + `&redirect_uri=${encodeURIComponent(REDIRECT)}`
      + `&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!);
  expect(location.toString()).toStartWith(config.oauth.consentUrl);
  expect(location.searchParams.get('request')).toMatch(/^req_/);
});

// The open-redirector guard, at the HTTP layer: an unknown client must get a page, never a 302 to
// whatever `redirect_uri` it supplied.
test('authorize renders an error page instead of redirecting for an unknown client', async () => {
  const response = await app.request(
    `/oauth/authorize?response_type=code&client_id=nope`
      + `&redirect_uri=${encodeURIComponent('https://attacker.example/cb')}`
      + `&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
  );
  expect(response.status).toBe(401);
  expect(response.headers.get('location')).toBeNull();
  expect(await response.text()).toContain('Rill could not start this sign-in');
});

test('a redirectable failure does go back to the registered redirect_uri with the state', async () => {
  const client = await (await post('/oauth/register', { redirect_uris: [REDIRECT] })).json() as { client_id: string };
  const response = await app.request(
    `/oauth/authorize?response_type=token&client_id=${client.client_id}`
      + `&redirect_uri=${encodeURIComponent(REDIRECT)}`
      + `&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=st`,
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!);
  expect(location.origin + location.pathname).toBe(REDIRECT);
  expect(location.searchParams.get('error')).toBe('unsupported_response_type');
  expect(location.searchParams.get('state')).toBe('st');
});

test('the full connect flow ends with a working, owner-scoped MCP session', async () => {
  const { tokens, keypair } = await connect();
  expect(tokens.token_type).toBe('Bearer');

  const response = await post(
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { Authorization: `Bearer ${tokens.access_token}` },
  );
  expect(response.status).toBe(200);
  const body = await response.json() as { result: { serverInfo: { name: string } } };
  expect(body.result.serverInfo.name).toBe('rill-actions');

  // A fresh address has published nothing, and that is a valid state — not an error.
  const list = await post(
    '/mcp',
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_actions', arguments: {} } },
    { Authorization: `Bearer ${tokens.access_token}` },
  );
  const listed = await list.json() as { result: { structuredContent: unknown[] } };
  expect(listed.result.structuredContent).toEqual([]);
  expect(keypair.toSuiAddress()).toMatch(/^0x[0-9a-f]{64}$/);
});

test('token responses are marked no-store so no intermediary caches them', async () => {
  const client = await (await post('/oauth/register', { redirect_uris: [REDIRECT] })).json() as { client_id: string };
  const response = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code: 'bogus' }).toString(),
  });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
});

test('revocation always answers 200, so it cannot be used to probe a token', async () => {
  const response = await app.request('/oauth/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'whatever' }).toString(),
  });
  expect(response.status).toBe(200);
});

// Discovery must work before a token exists, or a connector can never be added in the first place.
test('a browser GET on /mcp is redirected to the docs rather than 401', async () => {
  const response = await app.request('/mcp');
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe(`${config.publicBaseUrl}/api/docs`);
});

test('an MCP client probing for a GET event stream is told 405, not 401', async () => {
  const response = await app.request('/mcp', { headers: { Accept: 'text/event-stream' } });
  expect(response.status).toBe(405);
});
