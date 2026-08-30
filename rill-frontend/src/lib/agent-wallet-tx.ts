import { Transaction } from "@mysten/sui/transactions";

/**
 * Owner-side transactions for granting and revoking an agent wallet.
 *
 * These are the only transactions Rill ever asks a browser wallet to sign. Everything the agent does
 * afterwards is signed by the local `rill-wallet` key, bounded by what is granted here — so this
 * module is the whole surface where a human approves anything.
 *
 * Two of the three functions build a transaction from scratch rather than accepting server bytes.
 * That is deliberate, and it mirrors the local signer's `create_run_set` (R8): the backend's
 * `tradeCapPtb` is a TEMPLATE carrying a placeholder BalanceManager id that only becomes real after
 * the first transaction executes. Patching bytes to fill it in would mean signing a transaction
 * nobody could read; rebuilding it locally from values we just observed on-chain means the wallet
 * displays exactly what we constructed.
 */

/** SUI is the only budget coin type the onboarding path supports today. */
export const SUI_COIN_TYPE = "0x2::sui::SUI";

/**
 * Mint a DeepBook TradeCap from the freshly-created BalanceManager and hand it to the agent.
 *
 * Signed by the OWNER (only the BalanceManager's owner may mint), but transferred to the AGENT —
 * that split is the point: the owner keeps custody, the agent gets exactly the delegated authority
 * to place orders and nothing else.
 */
export function buildMintTradeCapTx(input: {
  deepbookPackageId: string;
  balanceManagerId: string;
  agent: string;
}): Transaction {
  const tx = new Transaction();
  const cap = tx.moveCall({
    target: `${input.deepbookPackageId}::balance_manager::mint_trade_cap`,
    arguments: [tx.object(input.balanceManagerId)],
  });
  tx.transferObjects([cap], input.agent);
  return tx;
}

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
  return changes
    ?.find((change) => change.type === "created" && change.objectType?.includes(typeSuffix))
    ?.objectId;
}

/** Everything the setup transaction is expected to create, harvested in one pass. */
export function harvestSetupObjects(changes: readonly ObjectChange[] | undefined): {
  walletId?: string;
  agentCapId?: string;
  balanceManagerId?: string;
  missing: string[];
} {
  const walletId = findCreatedObjectId(changes, "::agent_wallet::AgentWallet");
  const agentCapId = findCreatedObjectId(changes, "::agent_wallet::AgentCap");
  const balanceManagerId = findCreatedObjectId(changes, "::balance_manager::BalanceManager");

  const missing: string[] = [];
  if (!walletId) missing.push("AgentWallet");
  if (!agentCapId) missing.push("AgentCap");
  if (!balanceManagerId) missing.push("BalanceManager");

  return { walletId, agentCapId, balanceManagerId, missing };
}

/** Whether an onboarding actually separates the two roles. A single-key setup still works, but it
 *  gives the agent its own kill switch, so the UI must say so rather than imply a bound it lacks. */
export function isSelfOnboarding(owner: string, agent: string): boolean {
  return owner.trim().toLowerCase() === agent.trim().toLowerCase();
}

/**
 * Decode a base64 transaction the backend serialized (`serializeUnsignedPtb` → base64 of the
 * transaction JSON).
 *
 * Split out from `Transaction.from` because the decoding itself is where this quietly goes wrong:
 * `atob` yields a binary string of BYTES, not characters, so feeding it straight to a JSON parser
 * mangles any multi-byte UTF-8 in the payload. Going through `TextDecoder` keeps the round trip
 * exact.
 */
export function base64ToUtf8(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The backend's unsigned PTB, ready to hand to a browser wallet. */
export function decodeUnsignedPtb(base64: string): Transaction {
  return Transaction.from(base64ToUtf8(base64));
}
