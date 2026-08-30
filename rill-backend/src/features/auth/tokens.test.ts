import { expect, test } from 'bun:test';
import { bearerFromHeader, randomId, signToken, TokenError, verifyToken, type TokenClaims } from './tokens';

const SECRET = 'test-secret-not-a-real-one';
const AUD = 'https://api.rill.example/mcp';

function claims(overrides: Partial<TokenClaims> = {}): TokenClaims {
  return {
    t: 'access',
    sub: '0x' + 'a'.repeat(64),
    cid: 'rill_client_abc',
    scope: 'mcp offline_access',
    aud: AUD,
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: randomId(),
    ...overrides,
  };
}

test('a signed token round-trips to the same claims', () => {
  const original = claims();
  const decoded = verifyToken(signToken(original, SECRET), SECRET, { type: 'access', aud: AUD });
  expect(decoded).toEqual(original);
});

test('a token signed with a different secret is rejected', () => {
  const token = signToken(claims(), 'some-other-secret');
  expect(() => verifyToken(token, SECRET, { type: 'access', aud: AUD })).toThrow(TokenError);
});

// The whole point of putting `t` inside the MAC: a refresh token is a long-lived credential, and a
// resource server that accepted one as a bearer would turn a 30-day handle into a 30-day API key.
test('a refresh token is rejected where an access token is expected', () => {
  const token = signToken(claims({ t: 'refresh' }), SECRET);
  expect(() => verifyToken(token, SECRET, { type: 'access', aud: AUD })).toThrow(/Expected a access token/);
});

// RFC 8707 binding: a token minted for another deployment must not work here even if both happen to
// share a signing secret (a copied .env, a staging clone).
test('a token for a different audience is rejected', () => {
  const token = signToken(claims({ aud: 'https://someone-else.example/mcp' }), SECRET);
  expect(() => verifyToken(token, SECRET, { type: 'access', aud: AUD })).toThrow(/audience/);
});

test('an expired token is rejected', () => {
  const token = signToken(claims({ exp: Math.floor(Date.now() / 1000) - 1 }), SECRET);
  expect(() => verifyToken(token, SECRET, { type: 'access', aud: AUD })).toThrow(/expired/);
});

test('a token expiring in the future passes, and the boundary is exclusive', () => {
  const exp = Math.floor(Date.now() / 1000) + 10;
  const token = signToken(claims({ exp }), SECRET);
  // Exactly at expiry is already too late — `exp` is the first instant the token is invalid.
  expect(() => verifyToken(token, SECRET, { type: 'access', aud: AUD, nowMs: exp * 1000 })).toThrow(/expired/);
  expect(() => verifyToken(token, SECRET, { type: 'access', aud: AUD, nowMs: exp * 1000 - 1 })).not.toThrow();
});

test('a tampered payload is rejected even though it is still valid base64url JSON', () => {
  const token = signToken(claims(), SECRET);
  const [version, , signature] = token.split('.');
  // Re-encode a payload claiming a different subject, keeping the original signature.
  const forged = Buffer.from(JSON.stringify(claims({ sub: '0x' + 'b'.repeat(64) }))).toString('base64url');
  expect(() => verifyToken(`${version}.${forged}.${signature}`, SECRET, { type: 'access', aud: AUD }))
    .toThrow(/signature/);
});

test('malformed tokens are rejected rather than throwing something unexpected', () => {
  for (const bad of ['', 'not-a-token', 'v1.only-two', 'v9.abc.def', 'v1..', 'v1.###.###']) {
    expect(() => verifyToken(bad, SECRET, { type: 'access', aud: AUD })).toThrow(TokenError);
  }
});

// A signed-but-nonsense payload must not reach the caller as a half-populated claims object.
test('a correctly signed but structurally invalid payload is rejected', () => {
  const payload = Buffer.from(JSON.stringify({ t: 'access', sub: '' })).toString('base64url');
  const { createHmac } = require('node:crypto') as typeof import('node:crypto');
  const mac = createHmac('sha256', SECRET).update(`v1.${payload}`).digest('base64url');
  expect(() => verifyToken(`v1.${payload}.${mac}`, SECRET, { type: 'access', aud: AUD }))
    .toThrow(/Malformed token claims/);
});

test('signing without a secret is refused rather than producing an unprotected token', () => {
  expect(() => signToken(claims(), '')).toThrow(TokenError);
  expect(() => verifyToken('v1.a.b', '', { type: 'access', aud: AUD })).toThrow(/No signing secret/);
});

test('bearerFromHeader extracts the token and tolerates real-world header shapes', () => {
  expect(bearerFromHeader('Bearer abc123')).toBe('abc123');
  expect(bearerFromHeader('bearer   abc123  ')).toBe('abc123');
  expect(bearerFromHeader('Basic abc123')).toBeUndefined();
  expect(bearerFromHeader('')).toBeUndefined();
  expect(bearerFromHeader(undefined)).toBeUndefined();
  expect(bearerFromHeader(null)).toBeUndefined();
});

test('randomId returns distinct, URL-safe ids', () => {
  const ids = new Set(Array.from({ length: 50 }, () => randomId()));
  expect(ids.size).toBe(50);
  for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
});
