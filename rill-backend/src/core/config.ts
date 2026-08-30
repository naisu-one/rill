import { SuiGrpcClient } from '@mysten/sui/grpc';
import dotenv from 'dotenv';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadAgentWalletFromEnv } from './agent-wallet';

dotenv.config();

/**
 * Absolute path to the `rill-backend` package root (`src/core` is two levels below it) — anchors
 * path-relative config (today: `skillsStorePath`) to the package's own location instead of
 * `process.cwd()` (KTD-7/R7). A monorepo root script, a process manager, or a systemd unit that
 * launches this process from a different working directory must not silently read/write a
 * different `data/skills.json` than the one the operator configured. `import.meta.dir` is bun's
 * `__dirname` equivalent.
 */
const BACKEND_ROOT = path.resolve(import.meta.dir, '..', '..');

// Testnet is the safe default (KTD-7/R7) — an operator must opt INTO mainnet explicitly, not land
// on it by omission. Pairs with `assertBootSafe` below: mainnet additionally requires an explicit
// guard package id, so "no env configured" can never boot pointed at real funds unprotected.
const network = (process.env.SUI_NETWORK || 'testnet') as 'mainnet' | 'testnet';
const DEFAULT_RPC = network === 'testnet'
  ? 'https://fullnode.testnet.sui.io:443'
  : 'https://fullnode.mainnet.sui.io:443';

// Rill's own deployed contracts, keyed by network (like an SDK ships known addresses). Env overrides.
// Mainnet intentionally has no default — deploy + set RILL_GUARD_PACKAGE_ID before going live there.
const KNOWN_GUARD_PACKAGE: Partial<Record<string, string>> = {
  testnet: '0xadec99557cf7771bce94737fdd3ea0bcc989d81e0860f3e69af55433dae8c034',
};

const port = parseInt(process.env.PORT || '3000', 10);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;

/**
 * OAuth signing secret. Every access/refresh token this server issues is HMAC'd with it, so losing
 * it invalidates every live agent connection and leaking it lets anyone mint a token for any
 * address — it belongs in a secret manager, never in the repo.
 *
 * Unset on testnet, a random per-boot secret is generated instead: local development gets a working
 * OAuth server with zero setup, at the honest cost that a restart signs everyone out. Unset on
 * mainnet, `assertBootSafe` refuses to boot rather than let a production deploy silently run on a
 * secret that dies with the process (which would look like random, unexplainable 401s).
 */
const oauthSecretFromEnv = process.env.RILL_OAUTH_SECRET?.trim();
const oauthSecret = oauthSecretFromEnv
  || (network === 'mainnet' ? '' : randomBytes(32).toString('hex'));

export const config = {
  port,
  network,
  suiRpcUrl: process.env.SUI_RPC_URL || DEFAULT_RPC,
  mainnetRpcUrl: process.env.SUI_MAINNET_RPC_URL || 'https://fullnode.mainnet.sui.io:443',
  publicBaseUrl,
  agentWallet: loadAgentWalletFromEnv(),
  /** Published rill_guard package — the on-chain slippage chokepoint (assert_min_value). */
  guardPackageId: process.env.RILL_GUARD_PACKAGE_ID || KNOWN_GUARD_PACKAGE[network],
  /** Where published skills persist across restarts (file-backed store). Always an absolute path,
   *  resolved against `BACKEND_ROOT` (KTD-7) rather than `process.cwd()`. */
  skillsStorePath: path.resolve(BACKEND_ROOT, process.env.SKILLS_STORE_PATH || './data/skills.json'),
  walrusEnabled: (process.env.WALRUS_ENABLED || 'false').toLowerCase() === 'true',
  walrusUploadRelay:
    process.env.WALRUS_UPLOAD_RELAY || 'https://upload-relay.testnet.walrus.space',
  walrusEpochs: parseInt(process.env.WALRUS_EPOCHS || '3', 10),
  walrusMaxTipMist: parseInt(process.env.WALRUS_MAX_TIP_MIST || '5000000', 10),
  walrusExplorerBase:
    process.env.WALRUS_EXPLORER_BASE || 'https://walruscan.com/testnet/blob',

  /**
   * OAuth 2.1 authorization server — what turns "paste one URL into your agent and press Add" into
   * a working, per-user connection (the single-URL distribution model). Identity is a Sui address
   * proved by a wallet signature in Studio; there are no passwords and no user table.
   */
  oauth: {
    /** Signing secret for issued tokens. Empty only on a misconfigured mainnet — see the guard in
     *  `assertBootSafe`, which refuses to boot in exactly that case. */
    secret: oauthSecret,
    /** True when the secret came from the environment (i.e. survives a restart). Rendered in
     *  `/health` so an operator can see at a glance whether tokens are durable. */
    secretFromEnv: Boolean(oauthSecretFromEnv),
    /** AS + protected-resource state (clients, codes, refresh handles). Anchored to the package
     *  root for the same reason `skillsStorePath` is (KTD-7). */
    storePath: path.resolve(BACKEND_ROOT, process.env.OAUTH_STORE_PATH || './data/oauth.json'),
    /**
     * The protected resource identifier tokens are audience-bound to (RFC 8707). This is the
     * user-scoped MCP endpoint — the ONE URL a user pastes into Claude — not the legacy
     * per-skill `/api/mcp/:skillId` path, which stays public and unauthenticated.
     */
    resource: `${publicBaseUrl}/mcp`,
    /** Rill Studio page that runs wallet-connect + the signature. The AS redirects the browser
     *  here; Studio posts the signed consent back. */
    consentUrl: process.env.RILL_STUDIO_CONSENT_URL
      || `${(process.env.RILL_STUDIO_URL || 'https://rill.naisu.one').replace(/\/+$/, '')}/authorize`,
    /** Short — an access token is cheap to refresh and expensive to leak. */
    accessTokenTtlSeconds: parseInt(process.env.OAUTH_ACCESS_TTL_SECONDS || '3600', 10),
    /** Long, but rotating: every redemption invalidates the previous handle. */
    refreshTokenTtlSeconds: parseInt(process.env.OAUTH_REFRESH_TTL_SECONDS || `${60 * 60 * 24 * 30}`, 10),
    /** OAuth 2.1 recommends a code lifetime under a minute; it is redeemed within seconds. */
    authorizationCodeTtlSeconds: 60,
    /** How long a parked authorize request waits for the user to connect a wallet and sign. */
    authorizationRequestTtlSeconds: 10 * 60,
  },
};

/**
 * Fail-fast startup guard (KTD-7, R7): refuses to boot on `mainnet` without a deployed guard
 * package. Every on-chain slippage floor (a guardrail node's `minValue`, a Cetus swap's
 * `min_amount_out`) routes through `rill_guard::assert_min_value` (`features/protocols/guard.ts`'s
 * `injectMinOutAssert`); without a package id there, that call throws mid-compile instead of never
 * happening — so the *real* risk of an unset guard package on mainnet is a fleet of guardrail-only
 * flows that look protected in the UI but 500 on every compile, not a silent no-op. Failing at
 * startup surfaces that misconfiguration immediately instead of per-request.
 *
 * Exported (not just invoked inline below) so `config.test.ts` can pin the exact failure without
 * needing to re-import this module under a different `SUI_NETWORK` — `process.env` is only read
 * once, at module load, so re-triggering that read from a test isn't practical.
 */
export function assertBootSafe(cfg: {
  network: string;
  guardPackageId?: string;
  /**
   * The resolved OAuth signing secret. `''` means secret resolution ran and produced nothing (no
   * `RILL_OAUTH_SECRET`, and no per-boot fallback because this is mainnet) — that is the failure
   * this guard catches. `undefined` means the caller isn't asserting on this field at all, which
   * is what the partial objects in `config.test.ts` pass.
   */
  oauthSecret?: string;
}): void {
  if (cfg.network === 'mainnet' && cfg.oauthSecret === '') {
    throw new Error(
      'Refusing to start: SUI_NETWORK=mainnet requires RILL_OAUTH_SECRET (the HMAC secret every '
        + 'issued OAuth access/refresh token is signed with). On testnet a random per-boot secret is '
        + 'generated so local development needs no setup, but doing that on mainnet would sign every '
        + 'connected agent out on each restart and deploy. Generate one with '
        + '`openssl rand -hex 32`, store it in your secret manager, and set RILL_OAUTH_SECRET.',
    );
  }
  if (cfg.network === 'mainnet' && !cfg.guardPackageId) {
    throw new Error(
      'Refusing to start: SUI_NETWORK=mainnet requires RILL_GUARD_PACKAGE_ID (the deployed '
        + 'rill_guard package) to be set — without it, no guardrail or min_amount_out slippage floor '
        + 'can be enforced on-chain. Deploy rill_guard and set RILL_GUARD_PACKAGE_ID, or unset '
        + 'SUI_NETWORK / set it to "testnet" for local development.',
    );
  }
}

assertBootSafe({ ...config, oauthSecret: config.oauth.secret });

// Loud, once, at boot: an ephemeral secret works but is not durable, and the symptom of forgetting
// that (every agent 401s after a deploy) is far harder to diagnose than this line is to read.
if (!config.oauth.secretFromEnv) {
  console.warn(
    '[oauth] RILL_OAUTH_SECRET is unset — using a random per-boot secret. Every issued token '
      + 'becomes invalid when this process restarts, and connected agents must re-authorize. Set '
      + 'RILL_OAUTH_SECRET for anything longer-lived than local development.',
  );
}

export const suiClient = new SuiGrpcClient({ baseUrl: config.suiRpcUrl, network: config.network });
export const mainnetSuiClient = new SuiGrpcClient({ baseUrl: config.mainnetRpcUrl, network: 'mainnet' });
