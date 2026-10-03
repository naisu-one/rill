import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("network-scoped browser state", () => {
  it("separates mainnet drafts, publish results, and sessions from existing testnet keys", async () => {
    vi.stubEnv("VITE_SUI_NETWORK", "testnet");
    const testnetDraft = await import("./draft-storage");
    const testnetSession = await import("./rill-session");
    expect(testnetDraft.DRAFT_STORAGE_KEY).toBe("rill.builder.draft.v1");
    expect(testnetDraft.PUBLISH_STORAGE_KEY).toBe("rill.builder.publish.v1");
    const testnetSessionKey = testnetSession.SESSION_STORAGE_KEY;
    vi.resetModules();
    vi.stubEnv("VITE_SUI_NETWORK", "mainnet");
    const mainnetDraft = await import("./draft-storage");
    const mainnetSession = await import("./rill-session");
    expect(mainnetDraft.DRAFT_STORAGE_KEY).not.toBe(testnetDraft.DRAFT_STORAGE_KEY);
    expect(mainnetDraft.PUBLISH_STORAGE_KEY).not.toBe(testnetDraft.PUBLISH_STORAGE_KEY);
    expect(mainnetSession.SESSION_STORAGE_KEY).not.toBe(testnetSessionKey);
  });

  it("does not restore testnet wallet grants on mainnet at the same API and owner", async () => {
    const getItem = vi.fn().mockReturnValue(null);
    vi.stubGlobal("localStorage", { getItem });
    vi.stubEnv("VITE_SUI_NETWORK", "testnet");
    const testnet = await import("./grant-storage");
    testnet.loadGrantState("http://localhost:3939/api", "0x1");
    const testnetKey = getItem.mock.calls[0][0];
    vi.resetModules();
    vi.stubEnv("VITE_SUI_NETWORK", "mainnet");
    const mainnet = await import("./grant-storage");
    mainnet.loadGrantState("http://localhost:3939/api", "0x1");
    expect(getItem.mock.calls[1][0]).not.toBe(testnetKey);
  });
});
