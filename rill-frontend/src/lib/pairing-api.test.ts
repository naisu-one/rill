import { afterEach, expect, it, vi } from "vitest";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});
it("uses owner session only for prepare, list and confirmation", async () => {
  vi.stubEnv("VITE_RILL_API_URL", "https://api.example.org");
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ success: true, data: { requestId: "one" } })));
  vi.stubGlobal("fetch", fetch);
  const { rillApi } = await import("./rill-api");
  vi.spyOn(rillApi, "protocols").mockResolvedValue({} as never);
  await rillApi.preparePairing("agent", "testnet", "owner-session");
  expect(fetch).toHaveBeenLastCalledWith(
    "https://api.example.org/api/pairing/prepare",
    expect.objectContaining({
      body: JSON.stringify({ agent: "agent", network: "testnet" }),
      headers: expect.objectContaining({ Authorization: "Bearer owner-session" }),
    }),
  );
  fetch.mockResolvedValue(new Response(JSON.stringify({ success: true, data: [] })));
  await rillApi.pairedAgents("owner-session");
  expect(fetch).toHaveBeenLastCalledWith(
    "https://api.example.org/api/pairing",
    expect.objectContaining({ headers: { Authorization: "Bearer owner-session" } }),
  );
  fetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        success: true,
        data: { owner: "owner", agent: "agent", network: "testnet", pairedAt: 1 },
      }),
    ),
  );
  await rillApi.confirmPairing("one", "owner-session");
  expect(fetch).toHaveBeenLastCalledWith(
    "https://api.example.org/api/pairing/confirm",
    expect.objectContaining({ body: JSON.stringify({ requestId: "one" }) }),
  );
});
it("fetches the public challenge without owner credentials and checks network", async () => {
  vi.stubEnv("VITE_SUI_NETWORK", "testnet");
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { network: "testnet" } })),
    );
  vi.stubGlobal("fetch", fetch);
  const { rillApi } = await import("./rill-api");
  await rillApi.pairingChallenge("request/one");
  expect(fetch).toHaveBeenCalledWith(
    "http://localhost:3939/api/pairing/request%2Fone",
    expect.not.objectContaining({ headers: expect.anything() }),
  );
  fetch.mockResolvedValue(
    new Response(JSON.stringify({ success: true, data: { network: "mainnet" } })),
  );
  await expect(rillApi.pairingChallenge("one")).rejects.toThrow("does not match");
});
