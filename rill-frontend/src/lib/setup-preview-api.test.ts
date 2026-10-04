import { afterEach, expect, it, vi } from "vitest";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});
it("reads an exact owner-authenticated quote without requesting a funding transaction", async () => {
  vi.stubEnv("VITE_RILL_API_URL", "https://api.example.org");
  const preview = {
    inputBaseUnits: "5000000",
    inputCoinType: "sui",
    outputCoinType: "usdc",
    quotedOutputBaseUnits: "5873",
    minimumOutputBaseUnits: "10000",
    feeBaseUnits: "12500",
    outputFloorMet: false,
    note: "Preview only",
  };
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { swapPreview: preview } })),
    );
  vi.stubGlobal("fetch", fetch);
  const { rillApi } = await import("./rill-api");
  vi.spyOn(rillApi, "protocols").mockResolvedValue({} as never);
  const input = {
    skillId: "one",
    sender: "owner",
    agent: "agent",
    budgetMist: "7500000",
    perTxMist: "5000000",
  };
  expect(await rillApi.previewSetup(input, undefined, "owner-session")).toEqual({
    swapPreview: preview,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    "https://api.example.org/api/setup/preview",
    expect.objectContaining({
      body: JSON.stringify(input),
      headers: expect.objectContaining({ Authorization: "Bearer owner-session" }),
    }),
  );
});
