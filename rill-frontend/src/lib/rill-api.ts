import type { CapabilityManifest } from "../../../packages/rill-sdk/src";
import { validateProtocolRegistry, type ProtocolRegistry } from "./protocol-registry";
import { assertBackendNetwork } from "./sui-network";

export type { ProtocolRegistry } from "./protocol-registry";

const API_FALLBACK = "http://localhost:3939/api";

function normalizeApiBase(raw: string): string {
  const trimmed = raw.replace(/\/$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function resolveApiBase(): string {
  const fromEnv = import.meta.env.VITE_RILL_API_URL;
  if (fromEnv) return normalizeApiBase(fromEnv);
  return API_FALLBACK;
}

const API_BASE = resolveApiBase();

export type FlowEdge = {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
};

export type FlowNode = {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
};

export type FlowGraph = {
  nodes: FlowNode[];
  edges: FlowEdge[];
};

export type SimulationResult = {
  ok: boolean;
  verification: "verified" | "unverified";
  error?: string;
  gasEstimate: string;
  balanceChanges?: unknown[];
  objectChanges?: unknown[];
};

export type PublishResult = {
  skillId: string;
  name: string;
  description: string;
  mcpUrl: string;
  skillUrl?: string;
  toolDefs: {
    name: "build_action";
    description: string;
    inputSchema: {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
  warnings: string[];
  /** Sui address this skill was published under, when the publish call carried a session token. */
  owner?: string;
  /** The single connector URL serving every action this owner has published. Present only for an
   *  owned skill; prefer showing this over the per-skill `mcpUrl`. */
  ownerMcpUrl?: string;
};

export type PublishedSkillSummary = {
  id: string;
  name: string;
  description: string;
  mcpUrl: string;
  skillUrl?: string;
  createdAt: string;
};

/**
 * An owner-signed action grant as the Rust server prepares it: the run set an agent's local signer
 * may execute one action under. Kept opaque: the wallet signs the server's `message` byte-for-byte,
 * and the agent's signer recomputes that message from this grant and checks the signature against
 * the wallet's on-chain owner, so a server that showed one thing and stored another is refused there.
 */
export type ActionGrant = Record<string, unknown> & {
  actionId: string;
  actionName: string;
  agent: string;
  walletId: string;
  revision: number;
  expiresAtMs: string;
};

export type PreparedGrant = { grant: ActionGrant; message: string };

export type GrantInput = {
  actionId: string;
  walletId: string;
  budgetMist: string;
  perTxMist: string;
  expiresAtMs?: string;
  /** A DeepBook action's manager and capabilities, as onboarding bound them. */
  balanceManagerId?: string;
  tradeCapId?: string;
  depositCapId?: string;
};

/** Empty-wallet creation plan. Rules and funding follow through /setup/attach. */
export type SetupPlan = {
  setupPtb: string;
  runSetTemplate: Record<string, unknown>;
  requiresTradeCap: boolean;
  versionId: string;
  capabilityManifest: CapabilityManifest;
  budgetMist: string;
  walletPackageId: string;
  deepbookPackageId: string;
  owner: string;
  agent: string;
  ownerIsAgent: boolean;
};

export type SetupInput = {
  skillId: string;
  sender: string;
  agent?: string;
  budgetMist: string;
  perTxMist: string;
  minimumRemainingMist?: string;
  expiresAtMs?: string;
  /** Exact human decimal; never converted through a JavaScript number. */
  price?: string;
};

export type AttachSetupInput = SetupInput & {
  walletId: string;
  agentCapId: string;
  balanceManagerId?: string;
  tradeCapId?: string;
  depositCapId?: string;
};

export type CapabilityPreviewResult = {
  onChainRules: { module: string; config: Record<string, unknown> }[];
  signerPolicy: Record<string, unknown>;
  declaration: {
    summaryLines: string[];
    caps: { label: string; value: string; enforcement: "on-chain" | "pre-flight" }[];
  };
};

export type BackendFunction = {
  packageId?: string;
  module: string;
  name: string;
  isEntry?: boolean;
  parameters: {
    index: number;
    name: string | null;
    moveType: string;
    class: string;
  }[];
};

async function parseJsonResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `API returned non-JSON (${res.status} from ${res.url}): ${text.slice(0, 120) || "(empty body)"}`,
    );
  }
}

const REQUEST_TIMEOUT_MS = 20_000;

/** Every request gets a hard timeout so a hung backend can never leave a
 *  dialog spinning forever (R18); an optional caller-supplied signal (e.g.
 *  from useFlowRequest's per-call AbortController) is composed in via
 *  `AbortSignal.any` so unmount/re-run abort still works alongside it. */
function composeSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function post<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
  accessToken?: string,
): Promise<T> {
  await rillApi.protocols(signal);
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
    signal: composeSignal(signal),
  });
  const json = await parseJsonResponse<{ success: boolean; data?: T; error?: string }>(res);
  if (!res.ok || !json.success || !json.data) {
    throw new Error(json.error ?? `API error ${res.status}`);
  }
  return json.data;
}

/** The API's ORIGIN, without the `/api` prefix. The OAuth endpoints live at the origin root
 *  because RFC 8414/9728 define the discovery paths as origin-relative — see the backend's
 *  `http/routes/oauth.routes.ts`. */
const API_ORIGIN = API_BASE.replace(/\/api$/, "");

/** What the sign-in page shows and what the wallet must sign. `message` is passed through to the
 *  wallet byte-for-byte: the backend generated it, and nothing here may reconstruct or reformat it. */
export type ConsentPrompt = {
  requestId: string;
  clientName: string;
  scope: string;
  resource: string;
  network: string;
  message: string;
  expiresAt: string;
};

export const rillApi = {
  baseUrl: API_BASE,
  origin: API_ORIGIN,

  /** Read the parked authorize request an agent started. */
  async consentPrompt(requestId: string, signal?: AbortSignal): Promise<ConsentPrompt> {
    const res = await fetch(`${API_ORIGIN}/oauth/consent/${encodeURIComponent(requestId)}`, {
      signal: composeSignal(signal),
    });
    const json = await parseJsonResponse<{
      success?: boolean;
      data?: ConsentPrompt;
      error_description?: string;
    }>(res);
    if (!res.ok || !json.success || !json.data) {
      throw new Error(
        json.error_description ?? `Could not load this sign-in request (${res.status}).`,
      );
    }
    assertBackendNetwork(json.data.network);
    return json.data;
  },

  /** Submit the wallet signature; the response says where to send the browser next. */
  async completeConsent(
    requestId: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<{ redirectTo: string; address: string }> {
    const res = await fetch(`${API_ORIGIN}/oauth/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, signature }),
      signal: composeSignal(signal),
    });
    const json = await parseJsonResponse<{
      success?: boolean;
      data?: { redirectTo: string; address: string };
      error_description?: string;
    }>(res);
    if (!res.ok || !json.success || !json.data) {
      throw new Error(json.error_description ?? `Sign-in could not be completed (${res.status}).`);
    }
    return json.data;
  },

  async health(signal?: AbortSignal) {
    const root = API_BASE.replace(/\/api$/, "");
    const res = await fetch(`${root}/health`, { signal: composeSignal(signal) });
    return parseJsonResponse<Record<string, unknown>>(res);
  },

  async protocols(signal?: AbortSignal) {
    const res = await fetch(`${API_BASE}/protocols`, { signal: composeSignal(signal) });
    const json = await parseJsonResponse<{
      success: boolean;
      data?: ProtocolRegistry;
      error?: string;
    }>(res);
    if (!res.ok || !json.success || !json.data) {
      throw new Error(json.error ?? `API error ${res.status}`);
    }
    return validateProtocolRegistry(json.data);
  },

  introspect(packageId: string, signal?: AbortSignal) {
    return post<BackendFunction[]>("/introspect", { packageId }, signal);
  },

  simulate(flow: FlowGraph, signal?: AbortSignal) {
    return post<{
      unsignedPtb: string;
      preview: string;
      simulation: SimulationResult;
      warnings: string[];
    }>("/simulate", { flow }, signal);
  },

  /** Publishing WITH a token records the skill's owner, which is what makes it appear on that
   *  address's single `/mcp` connector. Without one it still publishes, just ownerless — the
   *  behavior Studio has always had. */
  publish(
    flow: FlowGraph,
    signal?: AbortSignal,
    accessToken?: string,
    manifest?: CapabilityManifest,
  ) {
    return post<PublishResult>(
      "/publish",
      { flow, ...(manifest ? { manifest } : {}) },
      signal,
      accessToken,
    );
  },

  /** Step 1 of the first-party Studio sign-in: the exact message the wallet must sign. */
  async walletChallenge(
    signal?: AbortSignal,
  ): Promise<{ challengeId: string; message: string; expiresAt: string }> {
    const res = await fetch(`${API_ORIGIN}/oauth/wallet-challenge`, {
      signal: composeSignal(signal),
    });
    const json = await parseJsonResponse<{
      success?: boolean;
      data?: { challengeId: string; message: string; expiresAt: string };
      error_description?: string;
    }>(res);
    if (!res.ok || !json.success || !json.data) {
      throw new Error(json.error_description ?? `Could not start sign-in (${res.status}).`);
    }
    return json.data;
  },

  /** Step 2: exchange the signature for a short-lived access token. */
  async walletToken(
    challengeId: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<{ access_token: string; expires_in: number; address: string }> {
    const res = await fetch(`${API_ORIGIN}/oauth/wallet-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId, signature }),
      signal: composeSignal(signal),
    });
    const json = await parseJsonResponse<{
      success?: boolean;
      data?: { access_token: string; expires_in: number; address: string };
      error_description?: string;
    }>(res);
    if (!res.ok || !json.success || !json.data) {
      throw new Error(json.error_description ?? `Sign-in failed (${res.status}).`);
    }
    return json.data;
  },

  previewCapabilities(manifest: CapabilityManifest, signal?: AbortSignal) {
    return post<CapabilityPreviewResult>("/capabilities/preview", { manifest }, signal);
  },

  /** Skills visible to the caller: with a token, the ones that address published; without, only
   *  ownerless ones. */
  async skills(accessToken?: string, signal?: AbortSignal): Promise<PublishedSkillSummary[]> {
    const res = await fetch(`${API_BASE}/skills`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      signal: composeSignal(signal),
    });
    const json = await parseJsonResponse<{
      success: boolean;
      data?: PublishedSkillSummary[];
      error?: string;
    }>(res);
    if (!res.ok || !json.success || !json.data) {
      throw new Error(json.error ?? `API error ${res.status}`);
    }
    return json.data;
  },

  /**
   * Build empty-wallet creation. `sender` is the owner; `agent` is the local signer that will spend.
   * The setup receipt supplies object IDs to attachSetup before any funds enter the wallet.
   */
  prepareSetup(input: SetupInput, signal?: AbortSignal, accessToken?: string) {
    return post<SetupPlan>("/setup/prepare", input, signal, accessToken);
  },

  /** The grant for running `actionId` from an already funded wallet, and the exact text to sign. */
  prepareGrant(input: GrantInput, signal?: AbortSignal, accessToken?: string) {
    return post<PreparedGrant>("/grants/prepare", input, signal, accessToken);
  },

  /** Store a grant the wallet's owner signed. The server verifies the signature before storing. */
  storeGrant(
    signed: { grant: ActionGrant; signature: string },
    signal?: AbortSignal,
    accessToken?: string,
  ) {
    return post<{ stored: boolean; revision: number; actionId: string; agent: string }>(
      "/grants",
      signed,
      signal,
      accessToken,
    );
  },

  /** Every grant held for one agent address. Public: ids and signatures, nothing secret. */
  async grantsFor(agent: string, signal?: AbortSignal) {
    const res = await fetch(`${API_BASE}/grants/${encodeURIComponent(agent)}`, {
      signal: composeSignal(signal),
    });
    const json = await parseJsonResponse<{
      success: boolean;
      data?: { grants: { grant: ActionGrant; signature: string }[] };
      error?: string;
    }>(res);
    if (!res.ok || !json.success || !json.data) {
      throw new Error(json.error ?? `API error ${res.status}`);
    }
    return json.data.grants;
  },

  attachSetup(input: AttachSetupInput, signal?: AbortSignal, accessToken?: string) {
    return post<{
      attachPtb: string;
      runSet: Record<string, unknown>;
      buildArguments: Record<string, unknown>;
    }>("/setup/attach", input, signal, accessToken);
  },
};
