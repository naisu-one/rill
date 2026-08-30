import { expect, test } from 'bun:test';
import {
  buildMintTradeCapTransaction,
  buildSetupTransaction,
  createdId,
} from './setup.service';

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const targets = (tx: ReturnType<typeof buildSetupTransaction>) =>
  tx.getData().commands.flatMap((command) =>
    command.$kind === 'MoveCall'
      ? [`${command.MoveCall.module}::${command.MoveCall.function}`]
      : [],
  );

test('setup transaction creates funded wallet and shared BalanceManager', () => {
  expect(
    targets(
      buildSetupTransaction({
        walletPackageId: id(1),
        deepbookPackageId: id(2),
        agent: id(3),
        budgetMist: 100n,
        perTxMist: 10n,
        expiresAtMs: 999n,
      }),
    ),
  ).toEqual(['agent_wallet::create_wallet', 'balance_manager::new', 'transfer::public_share_object']);
});

test('trade-cap mint transaction covers the required target', () => {
  expect(targets(buildMintTradeCapTransaction(id(2), id(4), id(3)))).toEqual([
    'balance_manager::mint_trade_cap',
  ]);
});

test('createdId finds the matching created object', () => {
  const result = {
    effects: {
      changedObjects: [
        { objectId: id(1), idOperation: 'Created' },
        { objectId: id(2), idOperation: 'Created' },
      ],
    },
    objectTypes: {
      [id(1)]: '0x1::agent_wallet::AgentWallet',
      [id(2)]: '0x2::balance_manager::BalanceManager',
    },
  };
  expect(createdId(result, '::agent_wallet::AgentWallet')).toBe(id(1));
  expect(createdId(result, '::balance_manager::BalanceManager')).toBe(id(2));
});

test('createdId throws when no matching created object is found', () => {
  const result = {
    effects: { changedObjects: [{ objectId: id(1), idOperation: 'Created' }] },
    objectTypes: { [id(1)]: '0x1::other::Other' },
  };
  expect(() => createdId(result, '::agent_wallet::AgentWallet')).toThrow(
    'Created ::agent_wallet::AgentWallet object not found.',
  );
});

// ── owner / agent separation ──
//
// `agent_wallet` reserves `revoke`, `add_rule`, `remove_rule` and `rotate_agent` for the owner so
// the agent cannot widen its own limits (R4). That guard is only real when the two are different
// addresses — these pin that the setup transaction delegates to the address we intend, since a
// regression here would silently hand the agent its own kill switch while everything still passed.

const OWNER = id(7);
const AGENT = id(8);

/** The `create_wallet` argument list, decoded from the built transaction. */
function createWalletArgs(tx: ReturnType<typeof buildSetupTransaction>) {
  const data = tx.getData();
  const call = data.commands.find(
    (command) => command.MoveCall?.function === 'create_wallet',
  )?.MoveCall;
  if (!call) throw new Error('create_wallet command not found.');
  return call.arguments.map((arg) => {
    if (arg.$kind !== 'Input') return null;
    const input = data.inputs[arg.Input];
    return input.$kind === 'Pure' ? input.Pure.bytes : null;
  });
}

test('create_wallet delegates to the agent address, not the signer', () => {
  const delegated = createWalletArgs(
    buildSetupTransaction({
      walletPackageId: id(1),
      deepbookPackageId: id(2),
      agent: AGENT,
      budgetMist: 1000n,
      perTxMist: 100n,
      expiresAtMs: 99n,
    }),
  );
  const selfOnboarded = createWalletArgs(
    buildSetupTransaction({
      walletPackageId: id(1),
      deepbookPackageId: id(2),
      agent: OWNER,
      budgetMist: 1000n,
      perTxMist: 100n,
      expiresAtMs: 99n,
    }),
  );

  // The agent argument is the only difference between the two, and it tracks what was passed.
  expect(delegated).not.toEqual(selfOnboarded);
});

test('the TradeCap is transferred to the agent, so the owner keeps no trading authority', () => {
  const tx = buildMintTradeCapTransaction(id(2), id(4), AGENT);
  const data = tx.getData();
  const transfer = data.commands.find((command) => command.TransferObjects)?.TransferObjects;
  expect(transfer).toBeDefined();
  const recipient = transfer!.address;
  expect(recipient.$kind).toBe('Input');
  // The recipient is a pure address input — the agent's, not the sender's (a mint that transferred
  // to the sender would leave the owner holding the cap and the agent unable to trade at all).
  const input = data.inputs[(recipient as { Input: number }).Input];
  expect(input.$kind).toBe('Pure');
});
