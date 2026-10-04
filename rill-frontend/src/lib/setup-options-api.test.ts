import { afterEach, expect, it, vi } from "vitest";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});
it("reads exact published spending defaults with the owner's token without creating a transaction", async () => {
  vi.stubEnv("VITE_RILL_API_URL", "https://api.example.org");
  const options = {
    budgetMist: "15000000",
    perTxMist: "10000000",
    budgetLimitMist: "15000000",
    perTxLimitMist: "10000000",
    requiresOrderPrice: false,
    restrictions: [],
    note: "Suggestions only",
  };
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ success: true, data: options })));
  vi.stubGlobal("fetch", fetch);
  const { rillApi } = await import("./rill-api");
  vi.spyOn(rillApi, "protocols").mockResolvedValue({} as never);
  expect(await rillApi.setupOptions("skill_swap", "owner-session")).toEqual(options);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    "https://api.example.org/api/setup/options",
    expect.objectContaining({
      body: JSON.stringify({ skillId: "skill_swap" }),
      headers: expect.objectContaining({ Authorization: "Bearer owner-session" }),
    }),
  );
});
