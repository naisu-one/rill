import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadGrantState, saveGrantState, type GrantState } from "./grant-storage";
const base = "http://localhost:3939/api",
  owner = "0x1";
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  });
});
function state(): GrantState {
  return {
    pending: {
      input: {
        sender: owner,
        skillId: "skill_1",
        agent: "0x2",
        budgetMist: "10",
        perTxMist: "5",
        expiresAtMs: "9999999999999",
      },
      plan: {
        setupPtb: "bytes",
        requiresTradeCap: false,
        walletPackageId: "0xa",
        deepbookPackageId: "0xb",
        versionId: "0xc",
        capabilityManifest: {
          walletCoinType: "0x2::sui::SUI",
          rules: [{ kind: "budget", totalMist: "10" }],
        },
        budgetMist: "10",
        owner,
        agent: "0x2",
        ownerIsAgent: false,
        runSetTemplate: {},
      },
      digest: "created",
      attachment: {
        digest: "submitted",
        runSet: { walletId: "0xd" },
        buildArguments: { sender: "0x2" },
      },
    },
    wallets: [],
  };
}
function wallet(walletId: string) {
  return {
    walletId,
    agentCapId: "0xe",
    walletPackageId: "0xa",
    owner,
    runSet: { actionId: "skill_1" },
    buildArguments: { sender: "0x2" },
    digest: `confirmed-${walletId}`,
  };
}
describe("grant recovery", () => {
  it("restores a submitted funding receipt and its artifacts after reload", () => {
    const s = state();
    expect(saveGrantState(base, owner, s)).toBe(true);
    expect(loadGrantState(base, owner)).toEqual(s);
  });
  it("separates wallet and backend state", () => {
    saveGrantState(base, owner, state());
    expect(loadGrantState(base, "0x2").pending).toBeNull();
    expect(loadGrantState("https://other/api", owner).pending).toBeNull();
  });
  it("preserves confirmed downloadable artifacts", () => {
    const s: GrantState = { pending: null, wallets: [wallet("0xd"), wallet("0xf")] };
    saveGrantState(base, owner, s);
    expect(loadGrantState(base, owner)).toEqual(s);
  });
  // A wallet onboarded before the list existed must still show up, or its owner loses the
  // page's revoke button for it.
  it("reads a version 1 single granted wallet as a one-wallet list", () => {
    localStorage.setItem(
      `rill:grant:v1:${encodeURIComponent(base)}:${owner}`,
      JSON.stringify({ version: 1, pending: null, granted: wallet("0xd") }),
    );
    expect(loadGrantState(base, owner)).toEqual({ pending: null, wallets: [wallet("0xd")] });
  });
  it("refuses a list that names another owner's wallet", () => {
    expect(
      saveGrantState(base, owner, { pending: null, wallets: [{ ...wallet("0xd"), owner: "0x9" }] }),
    ).toBe(false);
  });
  it("reports unavailable persistence without losing the caller state", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("quota");
      },
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(saveGrantState(base, owner, state())).toBe(false);
    expect(loadGrantState(base, owner)).toEqual({ pending: null, wallets: [] });
  });
});
