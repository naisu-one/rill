import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Compact, stateless, HMAC-signed bearer tokens for Rill's OAuth 2.1 authorization server.
 *
 * Deliberately NOT a JWT library: an OAuth access token is opaque to the client by spec (RFC 6749
 * §1.4 — the client never parses it), so the only consumer of this format is this server. A
 * hand-rolled `v1.<payload>.<sig>` keeps the auth surface auditable in one short file and adds no
 * dependency that could ship an `alg: none` class of bug. HMAC-SHA256 with a single server secret
 * is the right primitive here because there is exactly one issuer and one verifier.
 *
 * Two properties this file exists to guarantee:
 *
 * 1. **Type separation is signed, not inferred.** `t` ('access' | 'refresh') is inside the MAC and
 *    `verifyToken` requires the caller to state which type it expects. A refresh token replayed at
 *    the MCP endpoint as a bearer fails closed even though both are signed by the same secret.
 * 2. **Audience is signed.** `aud` pins the token to a specific resource (the MCP endpoint URL).
 *    A token minted for one deployment cannot be replayed against another that happens to share a
 *    secret — this is RFC 8707 resource-indicator binding, and the MCP auth spec requires it.
 */

/** Wire prefix. Bump only on a breaking payload change — a `v2.` token fails `verifyToken` here. */
const TOKEN_VERSION = 'v1';

export type TokenType = 'access' | 'refresh';

export interface TokenClaims {
  /** Token type — signed, so it can never be reinterpreted. See §1 above. */
  t: TokenType;
  /** Subject: the authenticated Sui address (the owner identity Rill scopes skills by). */
  sub: string;
  /** The OAuth client this token was issued to (a DCR-registered `client_id`). */
  cid: string;
  /** Space-delimited granted scopes, per RFC 6749 §3.3. */
  scope: string;
  /** Audience — the protected resource URL this token is valid for (RFC 8707). */
  aud: string;
  /** Expiry, seconds since epoch. */
  exp: number;
  /** Unique token id. For refresh tokens this is the rotation handle the store revokes. */
  jti: string;
}

/** Thrown for every rejection path so callers can map one error type to a 401. */
export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function macOf(payloadSegment: string, secret: string): string {
  return createHmac('sha256', secret).update(`${TOKEN_VERSION}.${payloadSegment}`).digest('base64url');
}

/** A fresh 256-bit random id, base64url — used for `jti` and for opaque codes elsewhere. */
export function randomId(): string {
  return randomBytes(32).toString('base64url');
}

export function signToken(claims: TokenClaims, secret: string): string {
  if (!secret) throw new TokenError('Refusing to sign a token without a signing secret.');
  const payload = base64url(JSON.stringify(claims));
  return `${TOKEN_VERSION}.${payload}.${macOf(payload, secret)}`;
}

/**
 * Verify and decode. Fail-closed at every step, and the MAC is compared in constant time — a
 * length-varying or early-exit compare leaks the expected signature one byte at a time to an
 * attacker who can time responses.
 *
 * `expected.aud` and `expected.type` are REQUIRED rather than optional-with-a-default: an optional
 * audience check is one forgotten argument away from accepting any token this server ever signed.
 */
export function verifyToken(
  token: string,
  secret: string,
  expected: { type: TokenType; aud: string; nowMs?: number },
): TokenClaims {
  if (!secret) throw new TokenError('No signing secret configured; refusing to verify.');
  if (typeof token !== 'string' || token.length === 0) throw new TokenError('Missing token.');

  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('Malformed token.');
  const [version, payload, signature] = parts;
  if (version !== TOKEN_VERSION) throw new TokenError('Unsupported token version.');

  const expectedMac = Buffer.from(macOf(payload, secret));
  const presentedMac = Buffer.from(signature);
  // `timingSafeEqual` throws on a length mismatch, which would itself be an early exit — so the
  // length is checked first and both branches end in the same generic rejection.
  if (expectedMac.length !== presentedMac.length || !timingSafeEqual(expectedMac, presentedMac)) {
    throw new TokenError('Invalid token signature.');
  }

  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenClaims;
  } catch {
    throw new TokenError('Malformed token payload.');
  }

  // Shape check before any field is trusted — a signed-but-garbage payload is still garbage.
  if (
    !claims
    || (claims.t !== 'access' && claims.t !== 'refresh')
    || typeof claims.sub !== 'string' || claims.sub === ''
    || typeof claims.cid !== 'string' || claims.cid === ''
    || typeof claims.aud !== 'string' || claims.aud === ''
    || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)
    || typeof claims.jti !== 'string' || claims.jti === ''
  ) {
    throw new TokenError('Malformed token claims.');
  }

  if (claims.t !== expected.type) throw new TokenError(`Expected a ${expected.type} token.`);
  if (claims.aud !== expected.aud) throw new TokenError('Token audience mismatch.');

  const now = expected.nowMs ?? Date.now();
  if (claims.exp * 1000 <= now) throw new TokenError('Token expired.');

  return claims;
}

/**
 * Extract a bearer token from an `Authorization` header. Returns `undefined` (never throws) so the
 * caller owns the 401 shape — an MCP client needs the `WWW-Authenticate` discovery header on that
 * response, which only the route layer can build.
 */
export function bearerFromHeader(header: string | undefined | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}
