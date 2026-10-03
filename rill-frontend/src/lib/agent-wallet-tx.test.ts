import { describe, expect, it } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import {
  buildRevokeTx,
  decodeUnsignedPtb,
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

describe("Rust unsigned transaction decoding", () => {
  it("decodes BCS TransactionKind and leaves sender and gas to the browser wallet", async () => {
    const source = new Transaction();
    const [coin] = source.splitCoins(source.gas, [source.pure.u64("123456789")]);
    source.transferObjects([coin], OWNER);
    const bytes = await source.build({ onlyTransactionKind: true });
    const decoded = decodeUnsignedPtb(Buffer.from(bytes).toString("base64"));
    expect(await decoded.build({ onlyTransactionKind: true })).toEqual(bytes);
    expect(decoded.getData().sender).toBeNull();
    expect(decoded.getData().gasData.payment).toBeNull();
  });
});

/** MoveCall targets in the built transaction, in order. */
function targets(tx: ReturnType<typeof buildRevokeTx>): string[] {
  return tx
    .getData()
    .commands.filter((command) => command.MoveCall)
    .map((command) => {
      const call = command.MoveCall!;
      return `${call.package}::${call.module}::${call.function}`;
    });
}

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
    {
      type: "mutated",
      objectId: id(6),
      objectType: `${PKG}::agent_wallet::AgentWallet<${SUI_COIN_TYPE}>`,
    },
    {
      type: "created",
      objectId: id(7),
      objectType: `${PKG}::agent_wallet::AgentWallet<${SUI_COIN_TYPE}>`,
    },
    { type: "created", objectId: id(8), objectType: `${PKG}::agent_wallet::AgentCap` },
    { type: "created", objectId: id(9), objectType: `${PKG}::balance_manager::BalanceManager` },
  ];

  it("requires all DeepBook caps created before the wallet is funded", () => {
    expect(harvestSetupObjects(changes, true).missing).toEqual(["TradeCap", "DepositCap"]);
    const harvested = harvestSetupObjects(
      [
        ...changes,
        { type: "created", objectId: id(4), objectType: `${PKG}::balance_manager::TradeCap` },
        { type: "created", objectId: id(5), objectType: `${PKG}::balance_manager::DepositCap` },
      ],
      true,
    );
    expect(harvested.missing).toEqual([]);
    expect(harvested.tradeCapId).toBe(id(4));
    expect(harvested.depositCapId).toBe(id(5));
  });

  it("does not require DeepBook objects for a swap or stake wallet", () => {
    expect(harvestSetupObjects(changes.slice(0, 3), false).missing).toEqual([]);
  });

  // Picking up a mutated object as "the new wallet" would point the run-set at something the user
  // never granted in this transaction.
  it("only matches created objects, never mutated ones", () => {
    expect(findCreatedObjectId(changes, "::agent_wallet::AgentWallet")).toBe(id(7));
  });

  it("harvests wallet and optional manager objects in one pass", () => {
    const harvested = harvestSetupObjects(changes, false);
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
    expect(partial.missing).toEqual(["AgentCap", "BalanceManager", "TradeCap", "DepositCap"]);
  });

  it("treats absent object changes as everything missing", () => {
    expect(harvestSetupObjects(undefined).missing).toEqual([
      "AgentWallet",
      "AgentCap",
      "BalanceManager",
      "TradeCap",
      "DepositCap",
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
