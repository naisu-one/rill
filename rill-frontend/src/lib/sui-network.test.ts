import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Studio Sui network", () => {
  it("defaults to testnet and configures both network providers", async () => {
    vi.stubEnv("VITE_SUI_NETWORK", "");
    const { SUI_NETWORK, SUI_NETWORKS } = await import("./sui-network");
    expect(SUI_NETWORK).toBe("testnet");
    expect(SUI_NETWORKS.testnet.network).toBe("testnet");
    expect(SUI_NETWORKS.mainnet.url).toBe("https://fullnode.mainnet.sui.io:443");
  });

  it("selects mainnet explicitly", async () => {
    vi.stubEnv("VITE_SUI_NETWORK", "mainnet");
    const { SUI_NETWORK } = await import("./sui-network");
    expect(SUI_NETWORK).toBe("mainnet");
  });

  it("rejects a misspelled network instead of silently selecting testnet", async () => {
    vi.stubEnv("VITE_SUI_NETWORK", "mainent");
    await expect(import("./sui-network")).rejects.toThrow("VITE_SUI_NETWORK");
  });
});
