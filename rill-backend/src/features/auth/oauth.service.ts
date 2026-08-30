import { createHash } from 'node:crypto';
import { config } from '../../core/config';
import {
  oauthStore,
  type AuthorizationRequest,
  type OAuthClient,
} from './oauth.store';
import { buildSignInMessage, verifySignInSignature } from './siws';
import { randomId, signToken, verifyToken, type TokenClaims } from './tokens';

/**
 * Rill's OAuth 2.1 authorization server — the piece that turns the MCP endpoint from "a secret URL
 * anyone who sees it can use" into "one public URL that knows who is calling".
 *
 * Why this exists at all, in one paragraph: before it, a published skill was reachable at
 * `/api/mcp/<skillId>` with no authentication, so the skill id was simultaneously the address AND
 * the only credential — and since a skill carries its own wallet binding, anyone who learned an id
 * could build actions against someone else's binding. It also meant a user connected one skill per
 * URL. Both problems have the same fix: authenticate the caller, then serve that caller's skills
 * from a single endpoint.
 *
 * The profile implemented here is the one MCP clients actually speak: OAuth 2.1 public client,
 * authorization code + PKCE (S256 only), dynamic client registration (RFC 7591), rotating refresh
 * tokens, and RFC 8707 resource binding. Dynamic registration is the load-bearing piece for the UX
 * goal — without it a user would have to create a client id somewhere and paste it, which is exactly
 * the multi-step setup this work exists to delete.
 */

const SUPPORTED_SCOPES = ['mcp', 'offline_access'] as const;
const DEFAULT_SCOPE = 'mcp offline_access';
const MAX_REDIRECT_URIS = 10;

/**
 * An OAuth-shaped failure. `redirectable` decides HOW the caller reports it, and getting that wrong
 * is a real vulnerability rather than a cosmetic slip: an error about an unregistered or mismatched
 * `redirect_uri` must NEVER be sent to that URI (RFC 6749 §4.1.2.1), or the endpoint becomes an open
 * redirector that launders attacker URLs through a trusted domain.
 */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly description: string,
    readonly status: number = 400,
    readonly redirectable: boolean = false,
  ) {
    super(`${code}: ${description}`);
    this.name = 'OAuthError';
  }
}

// ── discovery documents ──

/** RFC 8414. What an MCP client fetches to learn where to register, authorize, and get tokens. */
export function authorizationServerMetadata() {
  const base = config.publicBaseUrl;
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // S256 only. OAuth 2.1 removes `plain`, which offers no protection against an attacker who can
    // observe the authorization request.
    code_challenge_methods_supported: ['S256'],
    // Public clients only — see `registerClient`.
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SUPPORTED_SCOPES],
    resource_indicators_supported: true,
  };
}

/** RFC 9728. Points a client that got a 401 at the authorization server it should use. */
export function protectedResourceMetadata() {
  return {
    resource: config.oauth.resource,
    authorization_servers: [config.publicBaseUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: [...SUPPORTED_SCOPES],
  };
}

/** The `WWW-Authenticate` value every 401 from the MCP endpoint must carry, so a client can
 *  discover where to authenticate instead of just failing. */
export function wwwAuthenticateHeader(description?: string): string {
  const parts = [
    'Bearer realm="rill"',
    `resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource"`,
  ];
  if (description) parts.push(`error="invalid_token", error_description="${description.replace(/"/g, '')}"`);
  return parts.join(', ');
}

// ── redirect URI policy ──

/**
 * RFC 8252 §7: an agent client's redirect is one of exactly three shapes. Anything else is refused
 * at registration rather than at authorize time, so a client that would never be able to complete a
 * flow learns that immediately instead of after a user has already been sent to a wallet prompt.
 */
function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // A fragment is forbidden on a redirect URI (RFC 6749 §3.1.2) — the authorization response's own
  // parameters would collide with it.
  if (url.hash) return false;

  if (url.protocol === 'https:') return true;
  // Loopback only for http. `http://example.com` would send an authorization code over plaintext.
  if (url.protocol === 'http:') return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  // Private-use scheme for a native app, e.g. `com.example.agent:/callback`. Must be a reverse-DNS
  // style scheme, never a browser-navigable one.
  return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/i.test(url.protocol);
}

// ── dynamic client registration (RFC 7591) ──

export interface RegisterClientResult {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
  scope: string;
}

export function registerClient(body: unknown): RegisterClientResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new OAuthError('invalid_client_metadata', 'Registration body must be a JSON object.');
  }
  const meta = body as Record<string, unknown>;

  const redirectUris = meta.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris is required and must be a non-empty array.');
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    throw new OAuthError('invalid_redirect_uri', `At most ${MAX_REDIRECT_URIS} redirect_uris may be registered.`);
  }
  const uris: string[] = [];
  for (const uri of redirectUris) {
    if (typeof uri !== 'string' || !isAllowedRedirectUri(uri)) {
      throw new OAuthError(
        'invalid_redirect_uri',
        'Each redirect_uri must be https, http on loopback, or a private-use scheme, and carry no fragment.',
      );
    }
    uris.push(uri);
  }

  // A registration asking for a confidential-client auth method is refused rather than quietly
  // downgraded: the client would then expect to authenticate with a secret it never received and
  // fail at the token endpoint with a far more confusing error.
  const authMethod = meta.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== 'none') {
    throw new OAuthError(
      'invalid_client_metadata',
      'Only public clients are supported (token_endpoint_auth_method must be "none"); this server issues no client secrets.',
    );
  }

  const grantTypes = Array.isArray(meta.grant_types) && meta.grant_types.length > 0
    ? (meta.grant_types as unknown[]).map(String)
    : ['authorization_code', 'refresh_token'];
  const unsupportedGrant = grantTypes.find((g) => g !== 'authorization_code' && g !== 'refresh_token');
  if (unsupportedGrant) {
    throw new OAuthError('invalid_client_metadata', `Unsupported grant_type: ${unsupportedGrant}.`);
  }

  const responseTypes = Array.isArray(meta.response_types) && meta.response_types.length > 0
    ? (meta.response_types as unknown[]).map(String)
    : ['code'];
  const unsupportedResponse = responseTypes.find((r) => r !== 'code');
  if (unsupportedResponse) {
    throw new OAuthError('invalid_client_metadata', `Unsupported response_type: ${unsupportedResponse}.`);
  }

  const scope = typeof meta.scope === 'string' && meta.scope.trim() !== ''
    ? normalizeScope(meta.scope)
    : DEFAULT_SCOPE;

  const clientName = typeof meta.client_name === 'string' && meta.client_name.trim() !== ''
    // Bounded, and stripped of control characters AND quotes. This string is rendered verbatim into
    // the message the user's wallet displays and signs, so an unfiltered newline would let a
    // registering client forge extra lines into that prompt — appending its own claim right under
    // "grants no spending authority". Quotes go too, since the name is rendered inside them.
    ? meta.client_name.replace(/[\x00-\x1f\x7f"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64)
    : undefined;

  const client: OAuthClient = {
    clientId: `rill_client_${randomId().slice(0, 22)}`,
    clientName,
    redirectUris: uris,
    scope,
    createdAt: new Date().toISOString(),
  };
  oauthStore.saveClient(client);

  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: 'none',
    scope: client.scope,
  };
}

function normalizeScope(requested: string): string {
  const granted = requested
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .filter((s): s is (typeof SUPPORTED_SCOPES)[number] => (SUPPORTED_SCOPES as readonly string[]).includes(s));
  const unique = [...new Set(granted)];
  if (unique.length === 0) {
    throw new OAuthError('invalid_scope', `Supported scopes are: ${SUPPORTED_SCOPES.join(', ')}.`, 400, true);
  }
  return unique.join(' ');
}

/**
 * RFC 8707 resource indicator. Accepted when it names this deployment; rejected otherwise, because
 * silently issuing a token for a resource the client did not ask for is exactly the confused-deputy
 * problem resource indicators exist to prevent.
 */
function assertResourceAllowed(requested: string | undefined): string {
  if (!requested) return config.oauth.resource;
  const normalized = requested.replace(/\/+$/, '');
  const allowed = [config.oauth.resource, config.publicBaseUrl].map((v) => v.replace(/\/+$/, ''));
  if (!allowed.includes(normalized)) {
    throw new OAuthError('invalid_target', `Unknown resource: ${requested}.`, 400, true);
  }
  return config.oauth.resource;
}

// ── authorization endpoint ──

export interface AuthorizeQuery {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
  state?: string;
  resource?: string;
}

export interface AuthorizeStart {
  /** Where to send the browser: Rill Studio's consent + wallet-signature page. */
  consentUrl: string;
  requestId: string;
}

/**
 * Validate an authorization request and park it pending the user's wallet signature.
 *
 * Order matters here and is not stylistic: `client_id` and `redirect_uri` are validated FIRST and
 * their failures are non-redirectable, because until both are known-good there is no safe place to
 * send an error. Only afterwards do redirectable failures (bad response_type, bad scope, missing
 * PKCE) become errors the caller may bounce back to the client.
 */
export function beginAuthorization(query: AuthorizeQuery, nowMs: number = Date.now()): AuthorizeStart {
  const clientId = (query.client_id ?? '').trim();
  if (!clientId) {
    throw new OAuthError('invalid_request', 'client_id is required.');
  }
  const client = oauthStore.getClient(clientId);
  if (!client) {
    throw new OAuthError('invalid_client', 'Unknown client_id. Register the client first, or re-add the connector.', 401);
  }

  const redirectUri = (query.redirect_uri ?? '').trim();
  if (!redirectUri) {
    throw new OAuthError('invalid_request', 'redirect_uri is required.');
  }
  // Exact match against what was registered — no prefix matching, no wildcards. Prefix matching is
  // how open redirectors are born (`https://good.example/cb` also matching `https://good.example/cb.evil`).
  if (!client.redirectUris.includes(redirectUri)) {
    throw new OAuthError('invalid_request', 'redirect_uri does not match a registered redirect URI for this client.');
  }

  // From here on, failures are safe to report to the (now-validated) redirect_uri.
  if (query.response_type !== 'code') {
    throw new OAuthError('unsupported_response_type', 'Only the authorization code flow is supported.', 400, true);
  }
  if (query.code_challenge_method !== 'S256') {
    throw new OAuthError('invalid_request', 'PKCE is required with code_challenge_method=S256.', 400, true);
  }
  const codeChallenge = (query.code_challenge ?? '').trim();
  // 43 chars is the base64url length of a SHA-256 digest — the only valid S256 challenge length.
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeChallenge)) {
    throw new OAuthError('invalid_request', 'code_challenge is missing or malformed.', 400, true);
  }

  const scope = query.scope ? normalizeScope(query.scope) : client.scope;
  const resource = assertResourceAllowed(query.resource);

  const requestId = `req_${randomId().slice(0, 22)}`;
  const nonce = randomId().slice(0, 32);
  const expiresAt = nowMs + config.oauth.authorizationRequestTtlSeconds * 1000;
  const message = buildSignInMessage({
    domain: new URL(config.publicBaseUrl).host,
    clientName: client.clientName ?? 'an AI agent',
    resource,
    scope,
    nonce,
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  });

  const request: AuthorizationRequest = {
    requestId,
    kind: 'agent',
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUri,
    state: typeof query.state === 'string' ? query.state.slice(0, 512) : undefined,
    scope,
    codeChallenge,
    resource,
    message,
    expiresAt,
  };
  oauthStore.saveRequest(request);

  const consentUrl = new URL(config.oauth.consentUrl);
  consentUrl.searchParams.set('request', requestId);
  return { consentUrl: consentUrl.toString(), requestId };
}

/** What Studio renders on the consent screen. Deliberately excludes anything the browser has no
 *  business seeing (the PKCE challenge, the client's other redirect URIs). */
export function consentPrompt(requestId: string, nowMs: number = Date.now()) {
  const request = oauthStore.getRequest(requestId, nowMs);
  if (!request) {
    throw new OAuthError('invalid_request', 'This sign-in request has expired or was already used. Start again from your agent.', 404);
  }
  return {
    requestId: request.requestId,
    clientName: request.clientName ?? 'an AI agent',
    scope: request.scope,
    resource: request.resource,
    network: config.network,
    /** The exact bytes to sign. Studio must pass these through untouched. */
    message: request.message,
    expiresAt: new Date(request.expiresAt).toISOString(),
  };
}

/**
 * Complete consent: verify the wallet signature, mint a single-use authorization code, and hand
 * back the URL the browser should be sent to. The address that signed becomes the token subject.
 */
export async function completeConsent(
  input: { requestId?: unknown; signature?: unknown },
  nowMs: number = Date.now(),
): Promise<{ redirectTo: string; address: string }> {
  const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
  if (!requestId) throw new OAuthError('invalid_request', 'requestId is required.');

  // Read without consuming: a failed signature must leave the request usable so the user can retry
  // in the same tab rather than restarting the whole flow from the agent.
  const pending = oauthStore.getRequest(requestId, nowMs);
  if (!pending || pending.kind !== 'agent') {
    throw new OAuthError('invalid_request', 'This sign-in request has expired or was already used. Start again from your agent.', 404);
  }

  const address = await verifySignInSignature(
    pending.message,
    typeof input.signature === 'string' ? input.signature : '',
  );

  // Only now consume it, so exactly one code can ever be minted per authorize request.
  const request = oauthStore.takeRequest(requestId, nowMs);
  if (!request) {
    throw new OAuthError('invalid_request', 'This sign-in request was already completed.', 409);
  }

  const code = `rill_code_${randomId()}`;
  oauthStore.saveCode({
    code,
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    sub: address,
    scope: request.scope,
    resource: request.resource,
    expiresAt: nowMs + config.oauth.authorizationCodeTtlSeconds * 1000,
  });

  const redirectTo = new URL(request.redirectUri);
  redirectTo.searchParams.set('code', code);
  if (request.state !== undefined) redirectTo.searchParams.set('state', request.state);
  return { redirectTo: redirectTo.toString(), address };
}

/** Build the error redirect for a redirectable authorize failure (RFC 6749 §4.1.2.1). */
export function authorizeErrorRedirect(redirectUri: string, error: OAuthError, state?: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error.code);
  url.searchParams.set('error_description', error.description);
  if (state !== undefined) url.searchParams.set('state', state);
  return url.toString();
}

// ── token endpoint ──

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function verifyPkce(codeVerifier: string, codeChallenge: string): void {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) {
    throw new OAuthError('invalid_grant', 'code_verifier is missing or malformed.');
  }
  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  if (computed !== codeChallenge) {
    throw new OAuthError('invalid_grant', 'PKCE verification failed.');
  }
}

function issueTokens(
  input: { sub: string; clientId: string; scope: string; resource: string },
  nowMs: number,
): TokenResponse {
  const accessTtl = config.oauth.accessTokenTtlSeconds;
  const refreshTtl = config.oauth.refreshTokenTtlSeconds;
  const nowSeconds = Math.floor(nowMs / 1000);
  const refreshJti = randomId();

  const access = signToken(
    {
      t: 'access',
      sub: input.sub,
      cid: input.clientId,
      scope: input.scope,
      aud: input.resource,
      exp: nowSeconds + accessTtl,
      jti: randomId(),
    },
    config.oauth.secret,
  );
  const refresh = signToken(
    {
      t: 'refresh',
      sub: input.sub,
      cid: input.clientId,
      scope: input.scope,
      aud: input.resource,
      exp: nowSeconds + refreshTtl,
      jti: refreshJti,
    },
    config.oauth.secret,
  );

  // The signature alone would make the refresh token valid until expiry with no way to revoke it.
  // The stored handle is what makes rotation and revocation real.
  oauthStore.saveRefresh({
    jti: refreshJti,
    sub: input.sub,
    clientId: input.clientId,
    scope: input.scope,
    resource: input.resource,
    expiresAt: nowMs + refreshTtl * 1000,
  });

  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: accessTtl,
    refresh_token: refresh,
    scope: input.scope,
  };
}

export function exchangeToken(form: Record<string, string>, nowMs: number = Date.now()): TokenResponse {
  const grantType = form.grant_type;

  if (grantType === 'authorization_code') {
    const clientId = (form.client_id ?? '').trim();
    if (!clientId) throw new OAuthError('invalid_request', 'client_id is required.');
    const record = oauthStore.takeCode((form.code ?? '').trim(), nowMs);
    if (!record) throw new OAuthError('invalid_grant', 'Authorization code is invalid, expired, or already used.');
    // Both bindings are mandatory (RFC 6749 §4.1.3): a code is bound to the client it was issued to
    // and the redirect it was issued for, so a code leaked to another client is useless.
    if (record.clientId !== clientId) throw new OAuthError('invalid_grant', 'Authorization code was issued to a different client.');
    if ((form.redirect_uri ?? '').trim() !== record.redirectUri) {
      throw new OAuthError('invalid_grant', 'redirect_uri does not match the one used to obtain this code.');
    }
    verifyPkce((form.code_verifier ?? '').trim(), record.codeChallenge);
    if (form.resource) assertResourceAllowed(form.resource);

    return issueTokens(
      { sub: record.sub, clientId: record.clientId, scope: record.scope, resource: record.resource },
      nowMs,
    );
  }

  if (grantType === 'refresh_token') {
    const clientId = (form.client_id ?? '').trim();
    if (!clientId) throw new OAuthError('invalid_request', 'client_id is required.');

    let claims: TokenClaims;
    try {
      claims = verifyToken((form.refresh_token ?? '').trim(), config.oauth.secret, {
        type: 'refresh',
        aud: config.oauth.resource,
        nowMs,
      });
    } catch {
      throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired.');
    }
    if (claims.cid !== clientId) {
      throw new OAuthError('invalid_grant', 'Refresh token was issued to a different client.');
    }
    // Rotation: the handle is consumed here. A replay of the same refresh token now finds nothing.
    const handle = oauthStore.takeRefresh(claims.jti, nowMs);
    if (!handle) {
      throw new OAuthError('invalid_grant', 'Refresh token has already been used or was revoked.');
    }

    return issueTokens(
      { sub: handle.sub, clientId: handle.clientId, scope: handle.scope, resource: handle.resource },
      nowMs,
    );
  }

  throw new OAuthError('unsupported_grant_type', `Unsupported grant_type: ${grantType ?? '(missing)'}.`);
}

// ── resource-server side ──

export interface AuthenticatedCaller {
  /** The Sui address that owns this connection. Skills are scoped to it. */
  address: string;
  clientId: string;
  scope: string;
}

/**
 * Validate a bearer token presented at the MCP endpoint. Throws `OAuthError` with status 401 for
 * every failure so the route layer answers with one shape plus the `WWW-Authenticate` discovery
 * header — which is what lets a client know it should start the OAuth flow rather than give up.
 */
export function authenticateAccessToken(token: string | undefined, nowMs: number = Date.now()): AuthenticatedCaller {
  if (!token) {
    throw new OAuthError('invalid_token', 'An OAuth 2.1 access token is required.', 401);
  }
  let claims: TokenClaims;
  try {
    claims = verifyToken(token, config.oauth.secret, {
      type: 'access',
      aud: config.oauth.resource,
      nowMs,
    });
  } catch (err) {
    throw new OAuthError('invalid_token', err instanceof Error ? err.message : 'Invalid access token.', 401);
  }
  if (!claims.scope.split(' ').includes('mcp')) {
    throw new OAuthError('insufficient_scope', 'The "mcp" scope is required.', 403);
  }
  return { address: claims.sub, clientId: claims.cid, scope: claims.scope };
}

/** Revoke a refresh token (RFC 7009). Always succeeds from the client's perspective — the spec
 *  requires 200 even for an unknown token, so revocation cannot be used to probe validity. */
export function revokeToken(form: Record<string, string>): void {
  const token = (form.token ?? '').trim();
  if (!token) return;
  try {
    const claims = verifyToken(token, config.oauth.secret, {
      type: 'refresh',
      aud: config.oauth.resource,
    });
    oauthStore.takeRefresh(claims.jti);
  } catch {
    // Unknown, malformed, or already-expired token: nothing to do, and nothing to report.
  }
}

// ── Studio wallet session ──

/**
 * The publish side of the same identity.
 *
 * An agent authenticates through the full OAuth dance because it is a third-party client. Rill
 * Studio is not: it is the first-party page the user is already looking at, with their wallet
 * already connected. Sending it around an authorization-code redirect would add a round trip and a
 * registered client for no security gain — the wallet signature IS the proof, and it is the same
 * proof the agent flow ends in.
 *
 * What this exists to fix: `/publish` records an owner only when the caller presents a token, so
 * without a Studio session every published skill would be ownerless and could never appear on the
 * user's single `/mcp` endpoint. This closes that loop.
 *
 * It issues an ACCESS token only — no refresh handle. A browser tab can always ask the wallet to
 * sign again, so a long-lived refresh token sitting in web storage would be pure downside.
 */
const STUDIO_CLIENT_ID = 'rill_studio';

export function beginWalletChallenge(nowMs: number = Date.now()): {
  challengeId: string;
  message: string;
  expiresAt: string;
} {
  const challengeId = `sreq_${randomId().slice(0, 22)}`;
  const expiresAt = nowMs + config.oauth.authorizationRequestTtlSeconds * 1000;
  const message = buildSignInMessage({
    domain: new URL(config.publicBaseUrl).host,
    clientName: 'Rill Studio',
    resource: config.oauth.resource,
    scope: 'mcp',
    nonce: randomId().slice(0, 32),
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  });

  oauthStore.saveRequest({
    requestId: challengeId,
    kind: 'studio',
    clientId: STUDIO_CLIENT_ID,
    clientName: 'Rill Studio',
    // Unused by this flow — there is no redirect and no PKCE, because there is no third party to
    // hand a code to. Recorded as empty rather than optional so the stored shape stays one type.
    redirectUri: '',
    scope: 'mcp',
    codeChallenge: '',
    resource: config.oauth.resource,
    message,
    expiresAt,
  });

  return { challengeId, message, expiresAt: new Date(expiresAt).toISOString() };
}

export async function completeWalletChallenge(
  input: { challengeId?: unknown; signature?: unknown },
  nowMs: number = Date.now(),
): Promise<{ access_token: string; token_type: 'Bearer'; expires_in: number; address: string }> {
  const challengeId = typeof input.challengeId === 'string' ? input.challengeId.trim() : '';
  if (!challengeId) throw new OAuthError('invalid_request', 'challengeId is required.');

  const pending = oauthStore.getRequest(challengeId, nowMs);
  // The kind check is the boundary: an agent's parked authorize request must not be redeemable here
  // for a token that skips PKCE and the redirect binding entirely.
  if (!pending || pending.kind !== 'studio') {
    throw new OAuthError('invalid_request', 'This sign-in request has expired or was already used.', 404);
  }

  const address = await verifySignInSignature(pending.message, typeof input.signature === 'string' ? input.signature : '');

  // Single-use, like every other challenge here.
  if (!oauthStore.takeRequest(challengeId, nowMs)) {
    throw new OAuthError('invalid_request', 'This sign-in request was already completed.', 409);
  }

  const accessTtl = config.oauth.accessTokenTtlSeconds;
  const access = signToken(
    {
      t: 'access',
      sub: address,
      cid: STUDIO_CLIENT_ID,
      scope: 'mcp',
      aud: config.oauth.resource,
      exp: Math.floor(nowMs / 1000) + accessTtl,
      jti: randomId(),
    },
    config.oauth.secret,
  );

  return { access_token: access, token_type: 'Bearer', expires_in: accessTtl, address };
}
