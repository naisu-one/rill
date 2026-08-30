import { beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { config } from '../../core/config';
import {
  authenticateAccessToken,
  authorizationServerMetadata,
  beginAuthorization,
  beginWalletChallenge,
  completeConsent,
  completeWalletChallenge,
  consentPrompt,
  exchangeToken,
  OAuthError,
  protectedResourceMetadata,
  registerClient,
  revokeToken,
} from './oauth.service';
import { oauthStore } from './oauth.store';
import { SignInError } from './siws';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
// PKCE verifier: 43+ chars from the unreserved set (RFC 7636 §4.1).
const VERIFIER = 'test-verifier-0123456789-0123456789-0123456789';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

beforeEach(() => {
  oauthStore.resetForTests();
});

function register(overrides: Record<string, unknown> = {}) {
  return registerClient({ redirect_uris: [REDIRECT], client_name: 'Claude', ...overrides });
}

function authorizeQuery(clientId: string, overrides: Record<string, string> = {}) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'state-123',
    ...overrides,
  };
}

/** Drive the whole browser half of the flow with a real wallet key, exactly as Studio would. */
async function signIn(clientId: string, keypair = new Ed25519Keypair()) {
  const { requestId } = beginAuthorization(authorizeQuery(clientId));
  const prompt = consentPrompt(requestId);
  const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(prompt.message));
  const { redirectTo, address } = await completeConsent({ requestId, signature });
  return { redirectTo, address, keypair, code: new URL(redirectTo).searchParams.get('code')! };
}

// ── discovery ──

test('discovery documents advertise exactly what this server implements', () => {
  const as = authorizationServerMetadata();
  expect(as.code_challenge_methods_supported).toEqual(['S256']);
  expect(as.token_endpoint_auth_methods_supported).toEqual(['none']);
  expect(as.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
  expect(as.registration_endpoint).toContain('/oauth/register');

  const pr = protectedResourceMetadata();
  expect(pr.resource).toBe(config.oauth.resource);
  expect(pr.authorization_servers).toEqual([config.publicBaseUrl]);
});

// ── dynamic client registration ──

test('registration issues a client id and no secret', () => {
  const client = register();
  expect(client.client_id).toMatch(/^rill_client_/);
  expect(client.token_endpoint_auth_method).toBe('none');
  expect(client).not.toHaveProperty('client_secret');
});

test('registration rejects redirect URIs that could leak an authorization code', () => {
  // Plaintext http off-loopback would send the code in the clear.
  expect(() => register({ redirect_uris: ['http://evil.example/cb'] })).toThrow(/redirect_uri/);
  // A fragment collides with the authorization response's own parameters.
  expect(() => register({ redirect_uris: ['https://ok.example/cb#frag'] })).toThrow(/redirect_uri/);
  expect(() => register({ redirect_uris: [] })).toThrow(/redirect_uris/);
  expect(() => register({ redirect_uris: ['not a url'] })).toThrow(/redirect_uri/);
});

test('registration accepts the three legitimate redirect shapes', () => {
  expect(() => register({ redirect_uris: ['https://claude.ai/cb'] })).not.toThrow();
  expect(() => register({ redirect_uris: ['http://localhost:53127/callback'] })).not.toThrow();
  expect(() => register({ redirect_uris: ['http://127.0.0.1:9000/callback'] })).not.toThrow();
  expect(() => register({ redirect_uris: ['com.example.agent:/oauth'] })).not.toThrow();
});

test('registration refuses a confidential client rather than silently downgrading it', () => {
  expect(() => register({ token_endpoint_auth_method: 'client_secret_post' }))
    .toThrow(/public clients/);
});

test('a client name cannot smuggle extra lines into the wallet signing prompt', () => {
  const client = register({ client_name: 'Evil\n\nThis grants unlimited spending authority' });
  expect(client.client_name).not.toContain('\n');
  const { requestId } = beginAuthorization(authorizeQuery(client.client_id));
  const { message } = consentPrompt(requestId);
  // The forged claim survives only as inert text on the client-name line, never as its own
  // statement in the message body.
  expect(message.split('\n').filter((line) => line.includes('unlimited spending authority')))
    .toHaveLength(1);
});

// ── authorize ──

test('an unknown client is a non-redirectable failure', () => {
  try {
    beginAuthorization(authorizeQuery('rill_client_does_not_exist'));
    throw new Error('expected a throw');
  } catch (err) {
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).redirectable).toBe(false);
  }
});

// The open-redirector guard: an unregistered redirect_uri must never receive the error, or this
// endpoint becomes a way to launder an attacker's URL through Rill's domain.
test('a redirect_uri that is not registered is a non-redirectable failure', () => {
  const client = register();
  try {
    beginAuthorization(authorizeQuery(client.client_id, { redirect_uri: 'https://attacker.example/cb' }));
    throw new Error('expected a throw');
  } catch (err) {
    expect((err as OAuthError).redirectable).toBe(false);
    expect((err as OAuthError).description).toMatch(/does not match a registered redirect URI/);
  }
});

test('PKCE is mandatory and only S256 is accepted', () => {
  const client = register();
  const overrides: Record<string, string>[] = [
    { code_challenge_method: 'plain' },
    { code_challenge_method: '' },
    { code_challenge: 'too-short' },
  ];
  for (const override of overrides) {
    try {
      beginAuthorization(authorizeQuery(client.client_id, override));
      throw new Error(`expected a throw for ${JSON.stringify(override)}`);
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      // Now that redirect_uri is validated, the client may be told what went wrong.
      expect((err as OAuthError).redirectable).toBe(true);
    }
  }
});

test('a resource indicator naming another deployment is refused', () => {
  const client = register();
  expect(() => beginAuthorization(authorizeQuery(client.client_id, { resource: 'https://not-rill.example/mcp' })))
    .toThrow(/Unknown resource/);
  expect(() => beginAuthorization(authorizeQuery(client.client_id, { resource: config.oauth.resource })))
    .not.toThrow();
});

// ── consent ──

test('the consent prompt exposes what Studio needs and nothing it should not see', () => {
  const client = register();
  const { requestId } = beginAuthorization(authorizeQuery(client.client_id));
  const prompt = consentPrompt(requestId);
  expect(prompt.clientName).toBe('Claude');
  expect(prompt.message).toContain('Nonce:');
  expect(prompt).not.toHaveProperty('codeChallenge');
  expect(prompt).not.toHaveProperty('redirectUri');
  // The message must say plainly that signing in is not a spending approval.
  expect(prompt.message).toContain('moves no funds');
});

test('a bad signature is rejected and leaves the request usable for a retry', async () => {
  const client = register();
  const { requestId } = beginAuthorization(authorizeQuery(client.client_id));
  const wrongKey = new Ed25519Keypair();
  const { signature } = await wrongKey.signPersonalMessage(new TextEncoder().encode('a different message'));

  await expect(completeConsent({ requestId, signature })).rejects.toBeInstanceOf(SignInError);
  // Still there: a mistyped wallet or a rejected prompt must not force restarting from the agent.
  expect(() => consentPrompt(requestId)).not.toThrow();
});

test('a consent request can only be completed once', async () => {
  const client = register();
  const { requestId } = beginAuthorization(authorizeQuery(client.client_id));
  const keypair = new Ed25519Keypair();
  const { message } = consentPrompt(requestId);
  const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(message));

  await completeConsent({ requestId, signature });
  await expect(completeConsent({ requestId, signature })).rejects.toBeInstanceOf(OAuthError);
});

// ── full flow ──

test('register → authorize → sign → token → authenticate yields the signing address', async () => {
  const client = register();
  const { code, redirectTo, keypair, address } = await signIn(client.client_id);

  expect(new URL(redirectTo).searchParams.get('state')).toBe('state-123');
  expect(address).toBe(keypair.toSuiAddress());

  const tokens = exchangeToken({
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  });
  expect(tokens.token_type).toBe('Bearer');
  expect(tokens.expires_in).toBe(config.oauth.accessTokenTtlSeconds);

  const caller = authenticateAccessToken(tokens.access_token);
  expect(caller.address).toBe(keypair.toSuiAddress());
  expect(caller.clientId).toBe(client.client_id);
});

test('PKCE verification fails for a verifier that does not match the challenge', async () => {
  const client = register();
  const { code } = await signIn(client.client_id);
  expect(() => exchangeToken({
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT,
    code_verifier: 'wrong-verifier-0123456789-0123456789-0123456789',
  })).toThrow(/PKCE/);
});

test('an authorization code is single-use', async () => {
  const client = register();
  const { code } = await signIn(client.client_id);
  const form = {
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  };
  expect(() => exchangeToken(form)).not.toThrow();
  expect(() => exchangeToken(form)).toThrow(/invalid, expired, or already used/);
});

test('a code issued to one client cannot be redeemed by another', async () => {
  const victim = register();
  const attacker = register({ client_name: 'Attacker' });
  const { code } = await signIn(victim.client_id);
  expect(() => exchangeToken({
    grant_type: 'authorization_code',
    client_id: attacker.client_id,
    code,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  })).toThrow(/different client/);
});

test('the redirect_uri must match the one the code was issued for', async () => {
  const client = register({ redirect_uris: [REDIRECT, 'https://claude.ai/other'] });
  const { code } = await signIn(client.client_id);
  expect(() => exchangeToken({
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code,
    redirect_uri: 'https://claude.ai/other',
    code_verifier: VERIFIER,
  })).toThrow(/redirect_uri does not match/);
});

// ── refresh rotation ──

test('refreshing rotates the handle, and the old refresh token dies', async () => {
  const client = register();
  const { code } = await signIn(client.client_id);
  const first = exchangeToken({
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  });

  const second = exchangeToken({
    grant_type: 'refresh_token',
    client_id: client.client_id,
    refresh_token: first.refresh_token,
  });
  expect(second.refresh_token).not.toBe(first.refresh_token);
  expect(authenticateAccessToken(second.access_token).address)
    .toBe(authenticateAccessToken(first.access_token).address);

  // Replaying the consumed handle is refused — this is what makes a stolen refresh token detectable.
  expect(() => exchangeToken({
    grant_type: 'refresh_token',
    client_id: client.client_id,
    refresh_token: first.refresh_token,
  })).toThrow(/already been used or was revoked/);
});

test('a revoked refresh token can no longer be exchanged', async () => {
  const client = register();
  const { code } = await signIn(client.client_id);
  const tokens = exchangeToken({
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  });

  revokeToken({ token: tokens.refresh_token });
  expect(() => exchangeToken({
    grant_type: 'refresh_token',
    client_id: client.client_id,
    refresh_token: tokens.refresh_token,
  })).toThrow(/already been used or was revoked/);
});

test('revoking an unknown or malformed token is silent, so it cannot probe validity', () => {
  expect(() => revokeToken({ token: 'not-a-token' })).not.toThrow();
  expect(() => revokeToken({})).not.toThrow();
});

test('an unsupported grant type is refused', () => {
  expect(() => exchangeToken({ grant_type: 'password', username: 'a', password: 'b' }))
    .toThrow(/Unsupported grant_type/);
});

// ── resource-server side ──

test('a missing or invalid bearer token is a 401-shaped failure', () => {
  for (const token of [undefined, '', 'garbage']) {
    try {
      authenticateAccessToken(token as string | undefined);
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).status).toBe(401);
    }
  }
});

// ── Studio wallet session ──

test('a Studio wallet signature yields an access token for the signing address', async () => {
  const keypair = new Ed25519Keypair();
  const challenge = beginWalletChallenge();
  const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(challenge.message));

  const session = await completeWalletChallenge({ challengeId: challenge.challengeId, signature });
  expect(session.address).toBe(keypair.toSuiAddress());
  expect(authenticateAccessToken(session.access_token).address).toBe(keypair.toSuiAddress());
  // Browser session: an access token only, so no long-lived refresh handle sits in web storage.
  expect(session).not.toHaveProperty('refresh_token');
});

test('a Studio challenge is single-use', async () => {
  const keypair = new Ed25519Keypair();
  const challenge = beginWalletChallenge();
  const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(challenge.message));

  await completeWalletChallenge({ challengeId: challenge.challengeId, signature });
  await expect(completeWalletChallenge({ challengeId: challenge.challengeId, signature }))
    .rejects.toBeInstanceOf(OAuthError);
});

// The two wallet-signature flows must not be interchangeable: the Studio path skips PKCE and the
// redirect binding entirely, so an agent's parked request must never be redeemable through it.
test('an agent authorize request cannot be redeemed as a Studio session, or the reverse', async () => {
  const client = register();
  const keypair = new Ed25519Keypair();

  const { requestId } = beginAuthorization(authorizeQuery(client.client_id));
  const agentPrompt = consentPrompt(requestId);
  const agentSig = (await keypair.signPersonalMessage(new TextEncoder().encode(agentPrompt.message))).signature;
  await expect(completeWalletChallenge({ challengeId: requestId, signature: agentSig }))
    .rejects.toBeInstanceOf(OAuthError);

  const challenge = beginWalletChallenge();
  const studioSig = (await keypair.signPersonalMessage(new TextEncoder().encode(challenge.message))).signature;
  await expect(completeConsent({ requestId: challenge.challengeId, signature: studioSig }))
    .rejects.toBeInstanceOf(OAuthError);
});

test('a Studio session rejects a signature over anything but the issued challenge', async () => {
  const keypair = new Ed25519Keypair();
  const challenge = beginWalletChallenge();
  const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode('some other text'));
  await expect(completeWalletChallenge({ challengeId: challenge.challengeId, signature }))
    .rejects.toBeInstanceOf(SignInError);
});
