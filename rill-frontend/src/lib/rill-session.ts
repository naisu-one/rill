import { rillApi } from "./rill-api";

/**
 * The browser's Rill identity: a short-lived access token proving the connected wallet address.
 *
 * Why Studio needs one at all — a published skill records an `owner` only when the publish call
 * carries a token, and only an owned skill appears on the user's single `/mcp` connector URL.
 * Without a session, everything published here stays ownerless and reachable only through its
 * individual per-skill link.
 *
 * Stored in `sessionStorage`, not `localStorage`: this is a bearer credential, and scoping it to
 * the tab means closing it ends the session. It is also cheap to lose — re-signing is one wallet
 * prompt — so there is no reason to persist it further.
 */

export const SESSION_STORAGE_KEY = `rill.session.v2:${rillApi.origin}`;
/** Refresh a little before the real expiry so a publish can't be issued with a token that dies
 *  mid-flight. */
const EXPIRY_SKEW_MS = 30_000;

export type RillSession = {
  accessToken: string;
  address: string;
  expiresAtMs: number;
};

function isUsable(
  session: RillSession | null,
  address: string,
  nowMs: number,
): session is RillSession {
  return (
    session !== null &&
    // A session belongs to ONE address. Switching wallets in the middle of a Studio visit must
    // re-sign rather than silently publish under the previous address.
    session.address === address &&
    session.expiresAtMs - EXPIRY_SKEW_MS > nowMs
  );
}

export function loadSession(): RillSession | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RillSession>;
    if (
      typeof parsed.accessToken !== "string" ||
      typeof parsed.address !== "string" ||
      typeof parsed.expiresAtMs !== "number"
    )
      return null;
    return parsed as RillSession;
  } catch {
    // Corrupt or unreadable (private mode, cleared storage) — treat as signed out, never throw.
    return null;
  }
}

export function saveSession(session: RillSession): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage can be unavailable or full; the session still works for this page's lifetime.
  }
}

export function clearSession(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Nothing to do — see saveSession.
  }
}

/**
 * Return a usable session for `address`, signing in if there isn't one.
 *
 * `signMessage` is the wallet's `signPersonalMessage`, passed in rather than imported so this stays
 * a plain module (no React hook rules) and can be unit-tested without a wallet.
 */
export async function ensureSession(
  address: string,
  signMessage: (message: Uint8Array) => Promise<string>,
  nowMs: number = Date.now(),
): Promise<RillSession> {
  const existing = loadSession();
  if (isUsable(existing, address, nowMs)) return existing;

  const challenge = await rillApi.walletChallenge();
  // The backend's bytes, signed verbatim — never rebuilt here, so the user always signs exactly
  // what the server will verify.
  const signature = await signMessage(new TextEncoder().encode(challenge.message));
  const token = await rillApi.walletToken(challenge.challengeId, signature);

  if (token.address !== address) {
    // The signature resolved to a different address than the connected account — refuse rather than
    // publish under an identity the user did not pick.
    throw new Error("The wallet signed as a different address than the one connected.");
  }

  const session: RillSession = {
    accessToken: token.access_token,
    address: token.address,
    expiresAtMs: nowMs + token.expires_in * 1000,
  };
  saveSession(session);
  return session;
}
