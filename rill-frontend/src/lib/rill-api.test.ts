import { afterEach, describe, expect, it, vi } from "vitest";

const testnetRegistry = {
  network: "testnet",
  cetus_swap: {
    integratePackageId: "0x11", globalConfigId: "0x12", defaultPoolId: "0x13",
    defaultInputCoinType: "0x2::sui::SUI",
    tokens: [
      { symbol: "SUI", coinType: "0x2::sui::SUI" },
      { symbol: "USDC", coinType: "0x14a71d857b34677a7d57e0feb303df1adb515a37780645ab763d42ce8d1a5e48::usdc::USDC" },
    ],
    minSqrtPrice: "4295048016", maxSqrtPrice: "79226673515401279992447579055",
  },
  haedal_stake: {
    packageId: "0x21", stakeTarget: "0x21::interface::request_stake",
    suiSystemStateId: "0x5", stakingObjectId: "0x22", minStakeMist: "1000000000",
    coinType: "0x2::sui::SUI",
  },
  deepbook_limit_order: { pools: ["SUI_DBUSDC"] },
};

function backendFetch(data: unknown) {
  return vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify({
    success: true, data: url.endsWith("/protocols") ? testnetRegistry : data,
  }))));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Rust Studio API", () => {
  it("uses the local Rust server when no API URL is configured", async () => {
    vi.stubEnv("VITE_RILL_API_URL", "");
    const { rillApi } = await import("./rill-api");
    expect(rillApi.baseUrl).toBe("http://localhost:3939/api");
    expect(rillApi.origin).toBe("http://localhost:3939");
  });

  it("publishes capability rules with the flow and the wallet token", async () => {
    vi.stubEnv("VITE_RILL_API_URL", "http://localhost:3939/");
    const fetch = backendFetch({ skillId: "skill-1" });
    vi.stubGlobal("fetch", fetch);
    const { rillApi } = await import("./rill-api");
    const flow = { nodes: [{ id: "stake", type: "haedal_stake" }], edges: [] };
    const manifest = {
      walletCoinType: "0x2::sui::SUI",
      rules: [{ kind: "budget" as const, totalMist: "1000000000" }],
    };
    await rillApi.publish(flow, undefined, "wallet-token", manifest);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3939/api/publish",
      expect.objectContaining({
        body: JSON.stringify({ flow, manifest }),
        headers: { "Content-Type": "application/json", Authorization: "Bearer wallet-token" },
      }),
    );
  });

  it("preserves the exact onboarding decimal price", async () => {
    const fetch = backendFetch({});
    vi.stubGlobal("fetch", fetch);
    const { rillApi } = await import("./rill-api");
    await rillApi.prepareSetup({
      skillId: "skill-1",
      sender: "0x1",
      budgetMist: "1000000000",
      perTxMist: "1",
      price: "9007199254740993.000000001",
    });
    expect(JSON.parse(fetch.mock.calls[1][1].body).price).toBe("9007199254740993.000000001");
  });
});
