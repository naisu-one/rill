import { describe, expect, it } from "vitest";
import {
  base64ToUtf8,
  buildMintTradeCapTx,
  buildRevokeTx,
  findCreatedObjectId,
  harvestSetupObjects,
  isSelfOnboarding,
  SUI_COIN_TYPE,
  type ObjectChange,
} from "./agent-wallet-tx";

const id = (n: number) => `0x${String(n).repeat(64).slice(0, 64)}`;
const OWNER = id(1);
const AGENT = id(2);
const PKG = id(3);

/** MoveCall targets in the built transaction, in order. */
function targets(tx: ReturnType<typeof buildRevokeTx>): string[] {
  return tx.getData().commands
    .filter((command) => command.MoveCall)
    .map((command) => {
      const call = command.MoveCall!;
      return `${call.package}::${call.module}::${call.function}`;
    });
}

describe("buildMintTradeCapTx", () => {
  it("mints from the BalanceManager and transfers the cap onward", () => {
    const tx = buildMintTradeCapTx({
      deepbookPackageId: PKG,
      balanceManagerId: id(4),
      agent: AGENT,
    });
    expect(targets(tx)).toEqual([`${PKG}::balance_manager::mint_trade_cap`]);
    expect(tx.getData().commands.some((command) => command.TransferObjects)).toBe(true);
  });
});

describe("buildRevokeTx", () => {
  it("calls revoke and returns the reclaimed balance to the owner", () => {
    const tx = buildRevokeTx({ walletPackageId: PKG, walletId: id(5), owner: OWNER });
    expect(targets(tx)).toEqual([`${PKG}::agent_wallet::revoke`]);
    // The reclaimed coin MUST be transferred — `revoke` returns a Coin, and a transaction that
    // drops it does not type-check on-chain.
    expect(tx.getData().commands.some((command) => command.TransferObjects)).toBe(true);
  });

  it("defaults to SUI but honours an explicit budget coin type", () => {
    const suiTx = buildRevokeTx({ walletPackageId: PKG, walletId: id(5), owner: OWNER });
    const call = suiTx.getData().commands.find((command) => command.MoveCall)!.MoveCall!;
    expect(call.typeArguments).toEqual([SUI_COIN_TYPE]);

    const walTx = buildRevokeTx({
      walletPackageId: PKG,
      walletId: id(5),
      owner: OWNER,
      coinType: `${id(9)}::wal::WAL`,
    });
    const walCall = walTx.getData().commands.find((command) => command.MoveCall)!.MoveCall!;
    expect(walCall.typeArguments).toEqual([`${id(9)}::wal::WAL`]);
  });
});

describe("harvesting created objects", () => {
  const changes: ObjectChange[] = [
    { type: "mutated", objectId: id(6), objectType: `${PKG}::agent_wallet::AgentWallet<${SUI_COIN_TYPE}>` },
    { type: "created", objectId: id(7), objectType: `${PKG}::agent_wallet::AgentWallet<${SUI_COIN_TYPE}>` },
    { type: "created", objectId: id(8), objectType: `${PKG}::agent_wallet::AgentCap` },
    { type: "created", objectId: id(9), objectType: `${PKG}::balance_manager::BalanceManager` },
  ];

  // Picking up a mutated object as "the new wallet" would point the run-set at something the user
  // never granted in this transaction.
  it("only matches created objects, never mutated ones", () => {
    expect(findCreatedObjectId(changes, "::agent_wallet::AgentWallet")).toBe(id(7));
  });

  it("harvests all three onboarding objects in one pass", () => {
    const harvested = harvestSetupObjects(changes);
    expect(harvested).toMatchObject({
      walletId: id(7),
      agentCapId: id(8),
      balanceManagerId: id(9),
      missing: [],
    });
  });

  it("names exactly what is missing rather than failing opaquely", () => {
    const partial = harvestSetupObjects([changes[1]]);
    expect(partial.walletId).toBe(id(7));
    expect(partial.missing).toEqual(["AgentCap", "BalanceManager"]);
  });

  it("treats absent object changes as everything missing", () => {
    expect(harvestSetupObjects(undefined).missing).toEqual([
      "AgentWallet", "AgentCap", "BalanceManager",
    ]);
  });
});

describe("isSelfOnboarding", () => {
  // The UI must not claim a bound it does not have: when one key is both roles, the agent can call
  // revoke and add_rule on itself.
  it("detects a single-key setup, case- and whitespace-insensitively", () => {
    expect(isSelfOnboarding(OWNER, OWNER)).toBe(true);
    expect(isSelfOnboarding(OWNER, ` ${OWNER.toUpperCase()} `)).toBe(true);
    expect(isSelfOnboarding(OWNER, AGENT)).toBe(false);
  });
});

describe("base64ToUtf8", () => {
  // atob returns bytes-as-characters; decoding them as UTF-8 is what keeps a payload intact.
  it("round-trips multi-byte UTF-8 that a naive atob would mangle", () => {
    const original = JSON.stringify({ label: "sui → deepbook", note: "café ✓" });
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(original)));
    expect(base64ToUtf8(encoded)).toBe(original);
    expect(atob(encoded)).not.toBe(original);
  });

  it("round-trips plain ASCII unchanged", () => {
    const original = '{"version":2,"commands":[]}';
    expect(base64ToUtf8(btoa(original))).toBe(original);
  });
});
