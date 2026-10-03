import { afterEach, describe, expect, it, vi } from "vitest";

const SUI = "0x2::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const registry = () => ({
  network: "mainnet",
  cetus_swap: {
    integratePackageId: "0x11",
    globalConfigId: "0x12",
    defaultPoolId: "0x13",
    defaultInputCoinType: SUI,
    tokens: [{ symbol: "SUI", coinType: SUI }, { symbol: "USDC", coinType: USDC }],
    minSqrtPrice: "4295048016",
    maxSqrtPrice: "79226673515401279992447579055",
  },
  haedal_stake: {
    packageId: "0x21",
    stakeTarget: "0x21::interface::request_stake",
    suiSystemStateId: "0x5",
    stakingObjectId: "0x22",
    minStakeMist: "1000000000",
    coinType: SUI,
  },
  deepbook_limit_order: { pools: ["SUI_USDC"] },
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("network-specific protocol defaults", () => {
  it("blocks mainnet compilation until a matching complete registry is loaded", async () => {
    vi.stubEnv("VITE_SUI_NETWORK", "mainnet");
    const config = await import("./action-config");
    expect(() => config.buildCetusSwapFlowConfig({})).toThrow(/registry/i);
    expect(() => config.buildHaedalStakeFlowConfig({})).toThrow(/registry/i);
    expect(() => config.buildDeepbookOrderFlowConfig({})).toThrow(/registry/i);
  });

  it("uses mainnet registry packages, tokens, decimals and DeepBook pool", async () => {
    vi.stubEnv("VITE_SUI_NETWORK", "mainnet");
    const config = await import("./action-config");
    config.applyProtocolRegistry(registry());
    expect(config.buildCetusSwapFlowConfig({})).toMatchObject({
      integratePackageId: "0x11", pool: "0x13", inputCoinType: SUI,
      outputCoinType: USDC, min_amount_out: "10000",
    });
    expect(config.buildCetusSwapFlowConfig({ tokenIn: "USDC" }).amount_in).toBe("100000");
    expect(config.buildHaedalStakeFlowConfig({}).stakeTarget).toBe("0x21::interface::request_stake");
    expect(config.defaultActionConfig("deepbook", "limit_order").poolKey).toBe("SUI_USDC");
    expect(config.buildDeepbookOrderFlowConfig({}).poolKey).toBe("SUI_USDC");
  });

  it("rejects mismatched and incomplete registries without enabling mainnet defaults", async () => {
    vi.stubEnv("VITE_SUI_NETWORK", "mainnet");
    const config = await import("./action-config");
    expect(() => config.applyProtocolRegistry({ ...registry(), network: "testnet" })).toThrow(/network/i);
    const incomplete = registry();
    incomplete.cetus_swap.tokens = [];
    expect(() => config.applyProtocolRegistry(incomplete)).toThrow(/registry/i);
    expect(() => config.buildCetusSwapFlowConfig({})).toThrow(/registry/i);
  });

  it("rejects incomplete backend registry before submitting a flow", async () => {
    vi.stubEnv("VITE_SUI_NETWORK", "mainnet");
    const incomplete = registry();
    incomplete.cetus_swap.globalConfigId = "";
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      success: true, data: incomplete,
    }))));
    vi.stubGlobal("fetch", fetch);
    const { rillApi } = await import("./rill-api");
    await expect(rillApi.publish({ nodes: [], edges: [] })).rejects.toThrow(/registry/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("also blocks testnet requests to a mainnet backend", async () => {
    vi.stubEnv("VITE_SUI_NETWORK", "testnet");
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      success: true, data: registry(),
    }))));
    vi.stubGlobal("fetch", fetch);
    const { rillApi } = await import("./rill-api");
    await expect(rillApi.prepareSetup({
      skillId: "skill-1", sender: "0x1", budgetMist: "1", perTxMist: "1",
    })).rejects.toThrow(/network/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects backend network mismatch before submitting a mainnet flow", async () => {
    vi.stubEnv("VITE_SUI_NETWORK", "mainnet");
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      success: true, data: { ...registry(), network: "testnet" },
    }))));
    vi.stubGlobal("fetch", fetch);
    const { rillApi } = await import("./rill-api");
    await expect(rillApi.protocols()).rejects.toThrow(/network/i);
    await expect(rillApi.simulate({ nodes: [], edges: [] })).rejects.toThrow(/network/i);
    expect(fetch.mock.calls.every((call) => call[0].endsWith("/protocols"))).toBe(true);
  });
});
