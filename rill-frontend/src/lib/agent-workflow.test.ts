import { describe, expect, it } from "vitest";
import { buildAgentWorkflow } from "./agent-workflow";
import type { Granted } from "./grant-storage";
const grant = (walletId: string, actionId = "swap"): Granted => ({
  walletId,
  actionId,
  owner: "0x2",
  grantRevision: 1,
  agentCapId: "0xa",
  walletPackageId: "0xb",
  digest: "receipt",
  runSet: { network: "mainnet", sender: "0x1" },
  buildArguments: {},
});
describe("agent workflow export", () => {
  it("pins grants in the owner's chosen order with one signer", () => {
    const result = buildAgentWorkflow(
      [grant("0x3"), grant("0x4", "stake"), grant("0x5", "order")],
      "0x2",
      "mainnet",
      "run-one",
    );
    expect(result.steps.map((step) => step.actionId)).toEqual(["swap", "stake", "order"]);
    expect(result.signer).toBe("0x1");
    expect(result.steps[1]).toEqual({ actionId: "stake", walletId: "0x4", revision: 1 });
  });
  it.each([
    { owner: "0x7" },
    { grantRevision: undefined },
    { runSet: { network: "testnet", sender: "0x1" } },
    { runSet: { network: "mainnet", sender: "0x8" } },
  ])("refuses incompatible or unactivated grants %j", (change) => {
    expect(() =>
      buildAgentWorkflow(
        [grant("0x3"), { ...grant("0x4"), ...change }],
        "0x2",
        "mainnet",
        "run-one",
      ),
    ).toThrow();
  });
  it("refuses duplicate vaults and an empty workflow", () => {
    expect(() =>
      buildAgentWorkflow([grant("0x3"), grant("0x3")], "0x2", "mainnet", "run-one"),
    ).toThrow();
    expect(() => buildAgentWorkflow([], "0x2", "mainnet", "run-one")).toThrow();
  });
});
