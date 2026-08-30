#!/usr/bin/env bun
/**
 * OAuth 2.1 single-URL connector — full-flow test against a RUNNING backend (reproducible).
 *
 * Drives the exact sequence an MCP client performs when a user pastes the Rill URL into their agent
 * and presses Add, using a real Ed25519 wallet key for both halves of the identity:
 *
 *   register (DCR) → authorize → wallet signature → authorization code → token
 *   → Studio wallet session → publish → the action appears on the already-connected endpoint
 *
 * Then it asserts the things that would be silent, expensive bugs: that a DIFFERENT address sees
 * none of it, that an unknown skill id and someone else's skill id are indistinguishable, that the
 * legacy per-skill endpoint still works unauthenticated, and that a refresh token bound to one
 * client is refused for another.
 *
 * Everything here is local and keyless — no chain writes, no gas, no real funds. The keypairs are
 * generated per run and thrown away; they only ever sign a login message.
 *
 * Usage:
 *   bun run rill-backend/src/index.ts                 # in another terminal
 *   bun run rill-backend/scripts/oauth-local-test.ts
 *
 * Env: RILL_TEST_BASE_URL (default http://localhost:3939) — must match the running server's
 *      PUBLIC_BASE_URL, because tokens are audience-bound to it (RFC 8707) and a mismatch is
 *      correctly rejected.
 */
import { createHash } from 'node:crypto';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const BASE = (process.env.RILL_TEST_BASE_URL || 'http://localhost:3939').replace(/\/+$/, '');
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
// PKCE verifier: 43+ characters from the unreserved set (RFC 7636 §4.1).
const VERIFIER = 'rill-local-verifier-0123456789-0123456789-0123456789';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${res.status} from ${res.url}: ${text.slice(0, 200) || '(empty body)'}`);
  }
}

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const postForm = (path: string, form: Record<string, string>) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });

/** The agent half: register, authorize, sign the parked request, exchange the code. */
async function connectAgent(keypair: Ed25519Keypair) {
  const client = await readJson(await postJson('/oauth/register', {
    redirect_uris: [REDIRECT],
    client_name: 'Claude',
  }));

  const authorize = await fetch(
    `${BASE}/oauth/authorize?response_type=code&client_id=${client.client_id}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${CHALLENGE}`
    + '&code_challenge_method=S256&state=st&scope=mcp+offline_access',
    { redirect: 'manual' },
  );
  const location = authorize.headers.get('location');
  if (!location) throw new Error(`/oauth/authorize did not redirect (status ${authorize.status}).`);
  const requestId = new URL(location).searchParams.get('request');
  if (!requestId) throw new Error(`No request id in the consent redirect: ${location}`);

  // This is the step a human does in the browser: read the message, sign it in the wallet.
  const prompt = (await readJson(await fetch(`${BASE}/oauth/consent/${requestId}`))).data;
  const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(prompt.message));
  const consent = (await readJson(await postJson('/oauth/consent', { requestId, signature }))).data;
  const code = new URL(consent.redirectTo).searchParams.get('code')!;

  const tokens = await readJson(await postForm('/oauth/token', {
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  }));

  return { client, tokens, consentUrl: location, message: prompt.message };
}

/** The Studio half: one challenge, one signature, one short-lived access token. */
async function studioSession(keypair: Ed25519Keypair) {
  const challenge = (await readJson(await fetch(`${BASE}/oauth/wallet-challenge`))).data;
  const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(challenge.message));
  return (await readJson(await postJson('/oauth/wallet-token', {
    challengeId: challenge.challengeId,
    signature,
  }))).data;
}

const mcpCall = (token: string, method: string, params?: unknown) =>
  postJson('/mcp', { jsonrpc: '2.0', id: 1, method, params }, { Authorization: `Bearer ${token}` })
    .then(readJson);

async function main(): Promise<void> {
  console.log(`\nRill OAuth connector — local full-flow test against ${BASE}\n`);

  const health = await readJson(await fetch(`${BASE}/health`));
  check('server is up and reports the connector endpoint', health?.mcp?.endpoint === `${BASE}/mcp`,
    health?.mcp?.endpoint);
  if (health?.mcp?.tokensDurable === false) {
    console.log('  note  RILL_OAUTH_SECRET is unset: tokens die on restart (fine for this test).');
  }

  // ── discovery: what a client reads before it can do anything ──
  const resource = await readJson(await fetch(`${BASE}/.well-known/oauth-protected-resource`));
  check('protected-resource metadata points at this deployment', resource.resource === `${BASE}/mcp`);

  const as = await readJson(await fetch(`${BASE}/.well-known/oauth-authorization-server`));
  check('authorization server advertises DCR and S256 PKCE',
    as.registration_endpoint === `${BASE}/oauth/register`
    && as.code_challenge_methods_supported?.[0] === 'S256');

  const unauth = await postJson('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  check('an unauthenticated call is 401 with the discovery header',
    unauth.status === 401 && (unauth.headers.get('www-authenticate') ?? '').includes('resource_metadata'));

  // ── the owner connects an agent ──
  const owner = new Ed25519Keypair();
  const stranger = new Ed25519Keypair();

  const agent = await connectAgent(owner);
  check('the agent completes the OAuth flow', typeof agent.tokens.access_token === 'string');
  check('the signing prompt says plainly that this is not a spend approval',
    agent.message.includes('moves no funds'));
  console.log(`        the browser would open: ${agent.consentUrl}`);

  const before = await mcpCall(agent.tokens.access_token, 'tools/call', {
    name: 'list_actions', arguments: {},
  });
  check('a fresh address sees an empty catalogue, not an error',
    Array.isArray(before.result?.structuredContent) && before.result.structuredContent.length === 0);

  // ── the owner publishes from Studio, with the same wallet ──
  const studio = await studioSession(owner);
  check('the Studio session resolves to the same address', studio.address === owner.toSuiAddress());

  const publish = await readJson(await postJson(
    '/api/publish',
    { flow: { nodes: [{ id: 'order', type: 'deepbook_limit_order' }], edges: [] } },
    { Authorization: `Bearer ${studio.access_token}` },
  ));
  check('publish succeeds', publish.success === true, publish.error ?? '');
  check('the published skill records its owner', publish.data?.owner === owner.toSuiAddress());
  check('publish hands back the single connector URL', publish.data?.ownerMcpUrl === `${BASE}/mcp`);

  // The whole point of the single URL: no reconnection.
  const after = await mcpCall(agent.tokens.access_token, 'tools/call', {
    name: 'list_actions', arguments: {},
  });
  check('the new action appears on the ALREADY-connected endpoint',
    after.result.structuredContent.some((a: { actionId: string }) => a.actionId === publish.data.skillId));

  const tools = await mcpCall(agent.tokens.access_token, 'tools/list');
  check('a single-skill catalogue advertises that skill\'s exact params',
    Object.keys(tools.result.tools[2].inputSchema.properties.params.properties ?? {}).includes('poolKey'));

  // ── the authorization boundary ──
  const strangerAgent = await connectAgent(stranger);
  const strangerList = await mcpCall(strangerAgent.tokens.access_token, 'tools/call', {
    name: 'list_actions', arguments: {},
  });
  check('a different address sees none of it', strangerList.result.structuredContent.length === 0);

  const [theirs, missing] = await Promise.all([
    mcpCall(strangerAgent.tokens.access_token, 'tools/call', {
      name: 'describe_action', arguments: { actionId: publish.data.skillId },
    }),
    mcpCall(strangerAgent.tokens.access_token, 'tools/call', {
      name: 'describe_action', arguments: { actionId: 'skill_no_such_thing' },
    }),
  ]);
  check('someone else\'s skill id is indistinguishable from a nonexistent one',
    theirs.result.content[0].text === missing.result.content[0].text);

  // ── the legacy public endpoint is untouched ──
  const legacy = await readJson(await postJson(`/api/mcp/${publish.data.skillId}`, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_actions', arguments: {} },
  }));
  check('the legacy per-skill endpoint still works without a token',
    legacy.result?.structuredContent?.[0]?.actionId === publish.data.skillId);

  // ── refresh binding ──
  const otherClient = await connectAgent(owner);
  const crossClient = await readJson(await postForm('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: otherClient.client.client_id,
    refresh_token: agent.tokens.refresh_token,
  }));
  check('a refresh token is refused for a different client', crossClient.error === 'invalid_grant');

  const rotated = await readJson(await postForm('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: agent.client.client_id,
    refresh_token: agent.tokens.refresh_token,
  }));
  check('a refresh rotates to a new handle', typeof rotated.refresh_token === 'string'
    && rotated.refresh_token !== agent.tokens.refresh_token);

  const replay = await readJson(await postForm('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: agent.client.client_id,
    refresh_token: agent.tokens.refresh_token,
  }));
  check('replaying the consumed refresh token is refused', replay.error === 'invalid_grant');

  console.log(`\n  Published test skill: ${publish.data.skillId} (owner ${owner.toSuiAddress().slice(0, 10)}…)`);
  console.log('  It lives in the local skills store; delete rill-backend/data/skills.json to clear.\n');

  if (failures > 0) {
    console.error(`${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log('All checks passed.\n');
}

main().catch((err) => {
  console.error('\nTest run failed:', err instanceof Error ? err.message : err);
  console.error('Is the backend running, and does RILL_TEST_BASE_URL match its PUBLIC_BASE_URL?\n');
  process.exit(1);
});
