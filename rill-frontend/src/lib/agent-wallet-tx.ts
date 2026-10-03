import { Transaction } from "@mysten/sui/transactions";

/** Decode Rust setup transactions and build owner revocation locally. */

/** SUI is the only budget coin type the onboarding path supports today. */
export const SUI_COIN_TYPE = "0x2::sui::SUI";

/**
 * The kill switch. `agent_wallet::revoke` marks the wallet revoked and returns the remaining
 * balance as a coin, which must be transferred somewhere or the transaction cannot type-check —
 * so it goes back to the owner.
 *
 * Owner-only on-chain (abort 1 NOT_OWNER). This is the function that makes a granted budget
 * genuinely reversible, and it is why the owner must not be the same key as the agent: an agent
 * that can call this can also call `add_rule` and lift its own ceiling.
 */
export function buildRevokeTx(input: {
  walletPackageId: string;
  walletId: string;
  owner: string;
  coinType?: string;
}): Transaction {
  const tx = new Transaction();
  const reclaimed = tx.moveCall({
    target: `${input.walletPackageId}::agent_wallet::revoke`,
    typeArguments: [input.coinType ?? SUI_COIN_TYPE],
    arguments: [tx.object(input.walletId)],
  });
  tx.transferObjects([reclaimed], input.owner);
  return tx;
}

/** One entry of `objectChanges` as returned with `showObjectChanges`. */
export type ObjectChange = {
  type: string;
  objectId?: string;
  objectType?: string;
};

/**
 * Find the id of an object this transaction CREATED whose Move type contains `typeSuffix`.
 *
 * Matching on the created set only (never `mutated`) matters: a setup transaction also touches
 * objects that already existed, and picking one of those up as "the new wallet" would produce a
 * run-set pointing at something the user never granted. Returns undefined rather than throwing so
 * the caller can report which specific object was missing.
 */
export function findCreatedObjectId(
  changes: readonly ObjectChange[] | undefined,
  typeSuffix: string,
): string | undefined {
  return changes?.find(
    (change) => change.type === "created" && change.objectType?.includes(typeSuffix),
  )?.objectId;
}

/** Everything the setup transaction is expected to create, harvested in one pass. */
export function harvestSetupObjects(
  changes: readonly ObjectChange[] | undefined,
  requiresTradeCap = true,
): {
  walletId?: string;
  agentCapId?: string;
  balanceManagerId?: string;
  tradeCapId?: string;
  depositCapId?: string;
  missing: string[];
} {
  const walletId = findCreatedObjectId(changes, "::agent_wallet::AgentWallet");
  const agentCapId = findCreatedObjectId(changes, "::agent_wallet::AgentCap");
  const balanceManagerId = findCreatedObjectId(changes, "::balance_manager::BalanceManager");
  const tradeCapId = findCreatedObjectId(changes, "::balance_manager::TradeCap");
  const depositCapId = findCreatedObjectId(changes, "::balance_manager::DepositCap");

  const missing: string[] = [];
  if (!walletId) missing.push("AgentWallet");
  if (!agentCapId) missing.push("AgentCap");
  if (requiresTradeCap) {
    if (!balanceManagerId) missing.push("BalanceManager");
    if (!tradeCapId) missing.push("TradeCap");
    if (!depositCapId) missing.push("DepositCap");
  }

  return { walletId, agentCapId, balanceManagerId, tradeCapId, depositCapId, missing };
}

/** Whether an onboarding actually separates the two roles. A single-key setup still works, but it
 *  gives the agent its own kill switch, so the UI must say so rather than imply a bound it lacks. */
export function isSelfOnboarding(owner: string, agent: string): boolean {
  return owner.trim().toLowerCase() === agent.trim().toLowerCase();
}

/** Rust returns base64 BCS TransactionKind; the browser wallet supplies sender and gas. */
export function decodeUnsignedPtb(base64: string): Transaction {
  return Transaction.fromKind(base64);
}
