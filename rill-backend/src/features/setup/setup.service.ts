import {
  DeepBookClient,
  FLOAT_SCALAR,
  MAX_TIMESTAMP,
  mainnetCoins,
  mainnetPackageIds,
  mainnetPools,
  testnetCoins,
  testnetPackageIds,
  testnetPools,
} from '@mysten/deepbook-v3';
import { Transaction } from '@mysten/sui/transactions';
import { config, suiClient } from '../../core/config';
import { ValidationError } from '../../core/errors';
import { suiToMist } from '../../core/node-config';
import { serializeUnsignedPtb } from '../compiler/ptb.util';
import type { PublishedSkill } from '../mcp/skills.store';

const SUI = '0x2::sui::SUI';
const PLACEHOLDER_BALANCE_MANAGER_ID = '0x0000000000000000000000000000000000000000000000000000000000000000';

export interface PrepareSetupPlanResult {
  setupPtb: string;
  tradeCapPtb: string;
  runSetTemplate: Record<string, unknown>;
  walletPackageId: string;
  deepbookPackageId: string;
}

export function buildSetupTransaction(input: {
  walletPackageId: string;
  deepbookPackageId: string;
  agent: string;
  budgetMist: bigint;
  perTxMist: bigint;
  expiresAtMs: bigint;
}): Transaction {
  const tx = new Transaction();
  const [funds] = tx.splitCoins(tx.gas, [input.budgetMist]);
  tx.moveCall({
    target: `${input.walletPackageId}::agent_wallet::create_wallet`,
    typeArguments: [SUI],
    arguments: [
      funds,
      tx.pure.address(input.agent),
      tx.pure.u64(input.perTxMist),
      tx.pure.u64(input.expiresAtMs),
      tx.pure.vector('address', [input.deepbookPackageId]),
    ],
  });
  const manager = tx.moveCall({ target: `${input.deepbookPackageId}::balance_manager::new` });
  tx.moveCall({
    target: '0x2::transfer::public_share_object',
    typeArguments: [`${input.deepbookPackageId}::balance_manager::BalanceManager`],
    arguments: [manager],
  });
  return tx;
}

export function buildMintTradeCapTransaction(deepbookPackageId: string, balanceManagerId: string, agent: string): Transaction {
  const tx = new Transaction();
  const cap = tx.moveCall({
    target: `${deepbookPackageId}::balance_manager::mint_trade_cap`,
    arguments: [tx.object(balanceManagerId)],
  });
  tx.transferObjects([cap], agent);
  return tx;
}

export function createdId(
  result: { effects?: { changedObjects?: readonly { objectId: string; idOperation: string }[] }; objectTypes?: Record<string, string> },
  suffix: string,
): string {
  const objectId = (result.effects?.changedObjects ?? [])
    .filter((item) => item.idOperation === 'Created')
    .find((item) => result.objectTypes?.[item.objectId]?.includes(suffix))?.objectId;
  if (!objectId) throw new Error(`Created ${suffix} object not found.`);
  return objectId;
}

/**
 * Who signs the onboarding, and who gets the keys.
 *
 * These are two different parties, and conflating them is what makes the whole bounded-agent story
 * hollow: `agent_wallet` reserves `revoke`, `add_rule`, `remove_rule`, and `rotate_agent` for the
 * OWNER precisely so that the agent cannot widen its own limits (R4). If one key holds both roles,
 * every one of those guards protects nothing — the agent simply calls them itself.
 *
 * So `owner` signs the setup transactions and becomes the wallet's on-chain owner, while `agent`
 * only ever RECEIVES the `AgentCap` and `TradeCap` and is the address allowed to spend
 * (`request_spend` asserts `ctx.sender() == wallet.agent`, abort 7).
 *
 * `agent` is optional and defaults to `owner` — that is the self-onboarding path the local signer
 * still uses, where one local key legitimately plays both roles for a single-operator demo. It is a
 * deliberate convenience, not the intended production shape: pass a distinct `agent` (the local
 * signer's address, from its `signer_status` tool) to get the separation the contract is built for.
 */
export interface PrepareSetupPlanInput {
  skill: PublishedSkill;
  /** Signs both setup PTBs; becomes `wallet.owner` and holds the kill switch. */
  owner: string;
  /** Receives the AgentCap + TradeCap and spends within the budget. Defaults to `owner`. */
  agent?: string;
  budgetMist: bigint;
  perTxMist: bigint;
  minimumRemainingMist: bigint;
  expiresAtMs: bigint;
  clientOrderId?: string;
  /** Explicit onboarding-order price in human DeepBook units. Required when the pool's book is
   *  empty, since no mid price exists to derive one from. */
  price?: number;
}

export async function prepareSetupPlan(input: PrepareSetupPlanInput): Promise<PrepareSetupPlanResult> {
  const {
    skill,
    owner,
    budgetMist,
    perTxMist,
    minimumRemainingMist,
    expiresAtMs,
    clientOrderId,
    price: clientPrice,
  } = input;
  const agent = input.agent ?? owner;
  const network = config.network;
  const packageIds = network === 'mainnet' ? mainnetPackageIds : testnetPackageIds;
  const pools = network === 'mainnet' ? mainnetPools : testnetPools;
  const coins = network === 'mainnet' ? mainnetCoins : testnetCoins;
  const walletPackageId = config.agentWallet?.packageId;
  if (!walletPackageId) throw new Error('config.agentWallet.packageId is not configured.');
  const deepbookPackageId = packageIds.DEEPBOOK_PACKAGE_ID;

  const node = skill.flow.nodes.find((n) => n.type === 'deepbook_limit_order');
  const poolKey = (node?.config?.poolKey as string | undefined) ?? 'SUI_DBUSDC';
  const pool = pools[poolKey];
  if (!pool) throw new Error(`DeepBook pool ${poolKey} is unavailable on ${network}.`);

  const deepbook = new DeepBookClient({ client: suiClient as never, address: agent, network });
  const book = await deepbook.poolBookParams(poolKey);

  /**
   * The onboarding order is a deliberately-far ask that should never fill — it exists so the
   * run-set carries a real, placeable order, not so it trades. Its price is normally twice the
   * live mid.
   *
   * `midPrice` aborts (`book::mid_price`, abort 2) when the pool has NO resting orders, which is
   * the ordinary state of most DeepBook testnet pools — on 2026-08-29 six of the seven were empty,
   * `SUI_DBUSDC` (this function's own default) among them. That used to surface as an opaque 500
   * from a dependency, with nothing in the response explaining why onboarding was impossible.
   *
   * So: an explicit `price` wins when given, an empty book is reported as an actionable 422 rather
   * than a crash, and no fallback price is invented. Inventing one would be the dangerous option —
   * an ask cannot fill against an empty book *today*, but it rests, and a bid arriving later at a
   * carelessly-low guess would fill an order the user never intended to place.
   */
  const quantity = Math.max(book.minSize, book.lotSize);
  const midPrice = clientPrice === undefined
    ? await deepbook.midPrice(poolKey).catch(() => undefined)
    : undefined;
  if (clientPrice === undefined && midPrice === undefined) {
    throw new ValidationError(
      `DeepBook pool ${poolKey} has no resting orders on ${network}, so no market price can be `
      + 'derived for the onboarding order. Pass an explicit `price` (in human DeepBook units, well '
      + 'above the market so the order cannot fill), or choose a pool with a live order book.',
    );
  }
  const targetPrice = clientPrice ?? (midPrice as number) * 2;
  const price = Math.ceil(targetPrice / book.tickSize) * book.tickSize;
  const depositSui = quantity * 1.1;
  const baseCoin = coins[pool.baseCoin];
  const quoteCoin = coins[pool.quoteCoin];
  if (!baseCoin || !quoteCoin) throw new Error(`DeepBook coin metadata is unavailable for ${poolKey}.`);

  const computedPriceMist = BigInt(Math.round((price * FLOAT_SCALAR * quoteCoin.scalar) / baseCoin.scalar));
  const computedQuantityMist = BigInt(Math.round(quantity * baseCoin.scalar));
  // Single float→mist path (KTD-2): `depositSui` here is the exact same kind of quantity that
  // `deepbook.adapter.ts` and `skill-runner.service.ts` also convert to mist — this used to be the
  // one of the three call sites using `Math.ceil` while the other two used `Math.round`, so the
  // identical `depositSui` value could yield a different mist amount depending on which file
  // computed it. `computedPriceMist`/`computedQuantityMist` above are left as pool-scalar-ratio
  // arithmetic (not a single token-decimals shift like `depositSui`, so `decimalToBaseUnits`'s
  // `(value, decimals)` shape doesn't apply directly) — they are server-computed from trusted
  // DeepBook pool/book data, not request-supplied config, so R6 doesn't apply to them either.
  const spendAmountMist = suiToMist(depositSui, 'depositSui');
  if (spendAmountMist > perTxMist) {
    throw new Error(`Computed order spend ${spendAmountMist} exceeds per-tx cap ${perTxMist}.`);
  }
  if (budgetMist < perTxMist + minimumRemainingMist) {
    throw new Error('Wallet budget must cover one full per-tx spend plus the strategy minimum.');
  }

  const resolvedClientOrderId = clientOrderId ?? String(Date.now());
  const label = `${skill.id}_${Date.now()}`;

  const setupTx = buildSetupTransaction({
    walletPackageId,
    deepbookPackageId,
    agent,
    budgetMist,
    perTxMist,
    expiresAtMs,
  });
  // ponytail: trade-cap PTB is templated with a placeholder BalanceManager ID; the local signer
  // fills it with the actual ID created by the setup PTB before signing.
  const tradeCapTx = buildMintTradeCapTransaction(deepbookPackageId, PLACEHOLDER_BALANCE_MANAGER_ID, agent);

  const [setupPtb, tradeCapPtb] = await Promise.all([
    serializeUnsignedPtb(setupTx),
    serializeUnsignedPtb(tradeCapTx),
  ]);

  // There is ONE agent_wallet package now (the manifest-gated Rule + Hot Potato design) — a compiled
  // build_action PTB always calls request_spend/confirm_spend, never the retired legacy spend().
  // (Any per-manifest-rule `prove` calls aren't listed here: this template can't know the run-set's
  // capability manifest ahead of time.)
  const allowedTargets = [
    `${walletPackageId}::agent_wallet::request_spend`,
    `${walletPackageId}::agent_wallet::confirm_spend`,
    `${deepbookPackageId}::balance_manager::deposit`,
    `${deepbookPackageId}::balance_manager::generate_proof_as_trader`,
    `${deepbookPackageId}::pool::place_limit_order`,
  ];

  const runSetTemplate = {
    version: '1',
    label,
    actionId: skill.id,
    network,
    // The address that will submit every spend. `request_spend` asserts `ctx.sender() == wallet.agent`
    // (abort 7 NOT_AGENT), so this is the AGENT — putting the owner here would abort every spend.
    sender: agent,
    walletPackageId,
    walletId: '',
    agentCapId: '',
    balanceManagerId: '',
    tradeCapId: '',
    poolId: pool.address,
    allowedTargets,
    requiredGuards: [],
    maxAmountMist: perTxMist.toString(),
    minimumRemainingMist: minimumRemainingMist.toString(),
    demoParams: {
      poolKey,
      price,
      quantity,
      isBid: false,
      payWithDeep: false,
      clientOrderId: resolvedClientOrderId,
      depositSui,
    },
    onChainOrder: {
      clientOrderId: resolvedClientOrderId,
      orderType: '0',
      selfMatchingOption: '0',
      price: computedPriceMist.toString(),
      quantity: computedQuantityMist.toString(),
      isBid: false,
      payWithDeep: false,
      expiration: MAX_TIMESTAMP.toString(),
    },
  };

  return { setupPtb, tradeCapPtb, runSetTemplate, walletPackageId, deepbookPackageId };
}
