import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSession,
  ensureSession,
  loadSession,
  saveSession,
  SESSION_STORAGE_KEY,
  type RillSession,
} from "./rill-session";
import { rillApi } from "./rill-api";

const ADDRESS = `0x${"a".repeat(64)}`;
const OTHER = `0x${"b".repeat(64)}`;

function session(overrides: Partial<RillSession> = {}): RillSession {
  return {
    accessToken: "token-1",
    address: ADDRESS,
    expiresAtMs: Date.now() + 3_600_000,
    ...overrides,
  };
}

/** Stands in for the wallet. Records how often it was asked to sign. */
function wallet() {
  const calls: Uint8Array[] = [];
  return {
    calls,
    sign: async (message: Uint8Array) => {
      calls.push(message);
      return "signature";
    },
  };
}

beforeEach(() => {
  clearSession();
  vi.restoreAllMocks();
});

afterEach(() => {
  clearSession();
});

describe("session storage", () => {
  it("round-trips a saved session", () => {
    const value = session();
    saveSession(value);
    expect(loadSession()).toEqual(value);
  });

  it("treats corrupt or partial stored data as signed out rather than throwing", () => {
    sessionStorage.setItem(SESSION_STORAGE_KEY, "{not json");
    expect(loadSession()).toBeNull();

    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "x" }));
    expect(loadSession()).toBeNull();
  });
});

describe("ensureSession", () => {
  it("reuses a valid session without asking the wallet to sign again", async () => {
    saveSession(session());
    const w = wallet();
    const challenge = vi.spyOn(rillApi, "walletChallenge");

    const result = await ensureSession(ADDRESS, w.sign);

    expect(result.accessToken).toBe("token-1");
    expect(w.calls).toHaveLength(0);
    expect(challenge).not.toHaveBeenCalled();
  });

  // Switching wallets mid-visit must not publish under the previous address.
  it("re-signs when the stored session belongs to a different address", async () => {
    saveSession(session({ address: OTHER }));
    const w = wallet();
    vi.spyOn(rillApi, "walletChallenge").mockResolvedValue({
      challengeId: "sreq_1",
      message: "sign me",
      expiresAt: new Date().toISOString(),
    });
    vi.spyOn(rillApi, "walletToken").mockResolvedValue({
      access_token: "token-2",
      expires_in: 3600,
      address: ADDRESS,
    });

    const result = await ensureSession(ADDRESS, w.sign);

    expect(w.calls).toHaveLength(1);
    expect(result.accessToken).toBe("token-2");
    expect(loadSession()?.address).toBe(ADDRESS);
  });

  // A token that expires mid-request would fail the publish it was fetched for.
  it("re-signs when the stored session is inside the expiry skew", async () => {
    saveSession(session({ expiresAtMs: Date.now() + 5_000 }));
    const w = wallet();
    vi.spyOn(rillApi, "walletChallenge").mockResolvedValue({
      challengeId: "sreq_1",
      message: "sign me",
      expiresAt: new Date().toISOString(),
    });
    vi.spyOn(rillApi, "walletToken").mockResolvedValue({
      access_token: "token-3",
      expires_in: 3600,
      address: ADDRESS,
    });

    await ensureSession(ADDRESS, w.sign);
    expect(w.calls).toHaveLength(1);
  });

  it("signs the backend's message bytes verbatim", async () => {
    const w = wallet();
    vi.spyOn(rillApi, "walletChallenge").mockResolvedValue({
      challengeId: "sreq_1",
      message: "line one\nline two",
      expiresAt: new Date().toISOString(),
    });
    vi.spyOn(rillApi, "walletToken").mockResolvedValue({
      access_token: "token-4",
      expires_in: 3600,
      address: ADDRESS,
    });

    await ensureSession(ADDRESS, w.sign);
    expect(new TextDecoder().decode(w.calls[0])).toBe("line one\nline two");
  });

  // Defence against publishing under an identity the user did not pick.
  it("refuses a token whose address differs from the connected account", async () => {
    const w = wallet();
    vi.spyOn(rillApi, "walletChallenge").mockResolvedValue({
      challengeId: "sreq_1",
      message: "sign me",
      expiresAt: new Date().toISOString(),
    });
    vi.spyOn(rillApi, "walletToken").mockResolvedValue({
      access_token: "token-5",
      expires_in: 3600,
      address: OTHER,
    });

    await expect(ensureSession(ADDRESS, w.sign)).rejects.toThrow(/different address/);
    expect(loadSession()).toBeNull();
  });
});
