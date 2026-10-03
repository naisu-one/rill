import { afterEach, describe, expect, it, vi } from "vitest";

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
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { skillId: "skill-1" },
        }),
      ),
    );
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
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: {} })));
    vi.stubGlobal("fetch", fetch);
    const { rillApi } = await import("./rill-api");
    await rillApi.prepareSetup({
      skillId: "skill-1",
      sender: "0x1",
      budgetMist: "1000000000",
      perTxMist: "1",
      price: "9007199254740993.000000001",
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body).price).toBe("9007199254740993.000000001");
  });
});
