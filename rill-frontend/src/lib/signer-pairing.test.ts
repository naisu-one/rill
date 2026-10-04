import { describe, expect, it } from "vitest";
import { pairedForOwner, pairingCommand, samePairingContext } from "./signer-pairing";
const agent = `0x${"2".repeat(64)}`;
describe("local signer pairing", () => {
  it("discards completions after owner, signer or request changes", () => {
    const started = { owner: "owner", agent, requestId: "one" };
    expect(samePairingContext(started, started)).toBe(true);
    for (const changed of [
      { ...started, owner: "other" },
      { ...started, agent: "another" },
      { ...started, requestId: "two" },
    ]) {
      expect(samePairingContext(started, changed)).toBe(false);
    }
  });
  it("builds a local proof command with public values only", () => {
    expect(pairingCommand("request_1", "https://api.example.org", agent)).toBe(
      `rill-wallet pair --request 'request_1' --api 'https://api.example.org' --as '${agent}'`,
    );
  });
  it("rejects injected request IDs and credential-bearing URLs", () => {
    expect(() => pairingCommand("one; rm", "https://api.example.org", agent)).toThrow();
    expect(() => pairingCommand("one", "https://token@api.example.org", agent)).toThrow();
    expect(() => pairingCommand("one", "https://api.example.org?token=secret", agent)).toThrow();
  });
  it("isolates paired signers by owner and network and excludes self signing", () => {
    const base = { owner: "owner", agent, network: "mainnet", pairedAt: 1 };
    expect(
      pairedForOwner(
        [
          base,
          { ...base, owner: "other" },
          { ...base, network: "testnet" },
          { ...base, agent: "owner" },
        ],
        "owner",
        "mainnet",
      ),
    ).toEqual([base]);
  });
});
