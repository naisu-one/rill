import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../../core/config';

/**
 * Persistent state for the OAuth 2.1 authorization server: registered clients, in-flight
 * authorization requests, one-time authorization codes, and live refresh-token handles.
 *
 * File-backed for the same reason `skills.store.ts` is: a dynamically-registered client
 * (`/oauth/register`) must survive a restart or redeploy, or every connected agent silently breaks
 * on the next deploy and the user has to re-add the connector. Write volume is tiny (a register, an
 * authorize, a token exchange) so load-on-boot + atomic write-on-change is sufficient.
 *
 * Everything short-lived is pruned on load and before every write, so an abandoned authorize flow
 * or an expired refresh handle can never accumulate into an unbounded file.
 *
 * ponytail: file store, single-instance. Swap for Redis/a DB the moment this runs more than one
 * replica — two replicas would each hold half the authorization codes and reject the other's.
 */

/** A dynamically-registered public client (RFC 7591). No secret is ever issued: OAuth 2.1 public
 *  clients authenticate with PKCE, and a secret shipped to a desktop agent is not a secret. */
export interface OAuthClient {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  scope: string;
  createdAt: string;
}

/** An authorize request parked while the browser proves wallet ownership in Rill Studio. */
export interface AuthorizationRequest {
  requestId: string;
  /**
   * Which flow parked this request. Two different things end in a wallet signature — an AGENT
   * connecting over OAuth, and STUDIO signing in to publish as its own wallet — and they must not
   * be interchangeable: a signature collected for a Studio login must never be redeemable for an
   * agent's authorization code, and vice versa. The completion functions each require their own
   * kind, so a request can only be spent by the flow that created it.
   */
  kind: 'agent' | 'studio';
  clientId: string;
  clientName?: string;
  redirectUri: string;
  state?: string;
  scope: string;
  codeChallenge: string;
  resource: string;
  /** The EXACT message the wallet must sign. Generated server-side and handed to the browser
   *  verbatim so the two sides can never derive different bytes from the same intent. */
  message: string;
  expiresAt: number;
}

/** A one-time authorization code (RFC 6749 §4.1.2). Consumed on first use — see `takeCode`. */
export interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  /** The authenticated Sui address. */
  sub: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

/** A live refresh handle. The token itself is signed and stateless; this record is what makes it
 *  revocable — rotation deletes the old `jti`, so a replayed refresh token finds nothing. */
export interface RefreshHandle {
  jti: string;
  sub: string;
  clientId: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

interface OAuthState {
  clients: Record<string, OAuthClient>;
  requests: Record<string, AuthorizationRequest>;
  codes: Record<string, AuthorizationCode>;
  refresh: Record<string, RefreshHandle>;
}

function emptyState(): OAuthState {
  return { clients: {}, requests: {}, codes: {}, refresh: {} };
}

class OAuthStore {
  private state: OAuthState = emptyState();
  private readonly path = config.oauth.storePath;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<OAuthState>;
      this.state = {
        clients: raw.clients ?? {},
        requests: raw.requests ?? {},
        codes: raw.codes ?? {},
        refresh: raw.refresh ?? {},
      };
      this.prune();
      console.log(`[oauth] loaded ${Object.keys(this.state.clients).length} client(s) from ${this.path}`);
    } catch (err) {
      // Same posture as `skills.store.ts`: a corrupt file must not stop the server from booting.
      // Starting empty means clients must re-register (one "Add connector" click), which is
      // recoverable; refusing to boot is not.
      console.error(`[oauth] failed to load ${this.path} — starting empty:`, (err as Error).message);
      this.state = emptyState();
    }
  }

  /** Drop everything past its expiry. Called on load and before every persist. */
  private prune(nowMs: number = Date.now()): void {
    for (const key of Object.keys(this.state.requests)) {
      if (this.state.requests[key].expiresAt <= nowMs) delete this.state.requests[key];
    }
    for (const key of Object.keys(this.state.codes)) {
      if (this.state.codes[key].expiresAt <= nowMs) delete this.state.codes[key];
    }
    for (const key of Object.keys(this.state.refresh)) {
      if (this.state.refresh[key].expiresAt <= nowMs) delete this.state.refresh[key];
    }
  }

  private persist(): void {
    try {
      this.prune();
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path); // atomic swap — never leaves a half-written file
    } catch (err) {
      console.error(`[oauth] failed to persist ${this.path}:`, (err as Error).message);
    }
  }

  // ── clients ──

  saveClient(client: OAuthClient): void {
    this.state.clients[client.clientId] = client;
    this.persist();
  }

  getClient(clientId: string): OAuthClient | undefined {
    return this.state.clients[clientId];
  }

  // ── authorization requests (pending wallet signature) ──

  saveRequest(request: AuthorizationRequest): void {
    this.state.requests[request.requestId] = request;
    this.persist();
  }

  getRequest(requestId: string, nowMs: number = Date.now()): AuthorizationRequest | undefined {
    const request = this.state.requests[requestId];
    if (!request) return undefined;
    if (request.expiresAt <= nowMs) return undefined;
    return request;
  }

  /** Read AND remove — an authorize request is consumed by the consent that completes it, so a
   *  replayed consent POST (a double-submit, a re-opened tab) finds nothing rather than minting a
   *  second authorization code for the same request. */
  takeRequest(requestId: string, nowMs: number = Date.now()): AuthorizationRequest | undefined {
    const request = this.getRequest(requestId, nowMs);
    if (!request) return undefined;
    delete this.state.requests[requestId];
    this.persist();
    return request;
  }

  // ── authorization codes ──

  saveCode(code: AuthorizationCode): void {
    this.state.codes[code.code] = code;
    this.persist();
  }

  /** Read AND remove. Single-use is mandatory (OAuth 2.1 §4.1.3): a code that survives its first
   *  redemption is replayable by anyone who captured the redirect. */
  takeCode(code: string, nowMs: number = Date.now()): AuthorizationCode | undefined {
    const record = this.state.codes[code];
    if (!record) return undefined;
    delete this.state.codes[code];
    this.persist();
    if (record.expiresAt <= nowMs) return undefined;
    return record;
  }

  // ── refresh handles ──

  saveRefresh(handle: RefreshHandle): void {
    this.state.refresh[handle.jti] = handle;
    this.persist();
  }

  /** Read AND remove — refresh tokens ROTATE (OAuth 2.1 §4.3.1). The old handle dies the moment it
   *  is redeemed, so a stolen-and-replayed refresh token fails and the theft is observable. */
  takeRefresh(jti: string, nowMs: number = Date.now()): RefreshHandle | undefined {
    const handle = this.state.refresh[jti];
    if (!handle) return undefined;
    delete this.state.refresh[jti];
    this.persist();
    if (handle.expiresAt <= nowMs) return undefined;
    return handle;
  }

  /** Revoke every live refresh handle for one address — the "sign me out everywhere" primitive,
   *  and the thing to call if an address reports a compromised agent. Returns how many died. */
  revokeSubject(sub: string): number {
    let revoked = 0;
    for (const key of Object.keys(this.state.refresh)) {
      if (this.state.refresh[key].sub === sub) {
        delete this.state.refresh[key];
        revoked += 1;
      }
    }
    if (revoked > 0) this.persist();
    return revoked;
  }

  /** Test seam: drop all state without touching disk semantics beyond one write. */
  resetForTests(): void {
    this.state = emptyState();
    this.persist();
  }
}

export const oauthStore = new OAuthStore();
export type { OAuthState };
