import type { SetupInput, SetupPlan } from "./rill-api";
import { SUI_NETWORK } from "./sui-network";
export type PendingSetup = {
  input: SetupInput;
  plan: SetupPlan;
  digest: string;
  attachment?: {
    digest: string;
    runSet: Record<string, unknown>;
    buildArguments: Record<string, unknown>;
  };
};

export type Granted = {
  walletId: string;
  agentCapId: string;
  balanceManagerId?: string;
  tradeCapId?: string;
  depositCapId?: string;
  walletPackageId: string;
  owner: string;
  runSet: Record<string, unknown>;
  buildArguments: Record<string, unknown>;
  digest: string;
  /** What the owner set during onboarding, reused to prepare the action grant. Absent on state
   *  saved before grants existed, where the run set's own values are used instead. */
  actionId?: string;
  budgetMist?: string;
  perTxMist?: string;
  expiresAtMs?: string;
  /** The revision of the owner-signed grant the agent can now run, once stored. */
  grantRevision?: number;
};

/** Every wallet this owner onboarded from this browser, newest first, plus the one being set up.
 *  A list because an owner runs more than one: one per action, or a fresh one after a change of
 *  limits. Keeping a single slot meant a second wallet could only be made by revoking the first. */
export type GrantState = { pending: PendingSetup | null; wallets: Granted[] };

const empty = (): GrantState => ({ pending: null, wallets: [] });
function key(base: string, owner: string): string {
  const networkSuffix = SUI_NETWORK === "testnet" ? "" : `:${SUI_NETWORK}`;
  return `rill:grant:v1:${encodeURIComponent(base)}:${owner.toLowerCase()}${networkSuffix}`;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validGranted(value: unknown): value is Granted {
  return (
    record(value) &&
    typeof value.owner === "string" &&
    typeof value.walletId === "string" &&
    typeof value.digest === "string" &&
    record(value.runSet) &&
    record(value.buildArguments)
  );
}
function validPending(value: unknown): value is PendingSetup {
  if (
    !record(value) ||
    typeof value.digest !== "string" ||
    !record(value.input) ||
    typeof value.input.sender !== "string" ||
    !record(value.plan) ||
    typeof value.plan.setupPtb !== "string"
  )
    return false;
  const attachment = value.attachment;
  return (
    attachment === undefined ||
    (record(attachment) &&
      typeof attachment.digest === "string" &&
      record(attachment.runSet) &&
      record(attachment.buildArguments))
  );
}
function belongs(state: GrantState, owner: string): boolean {
  const mine = (address: string) => address.toLowerCase() === owner.toLowerCase();
  return (
    (!state.pending || mine(state.pending.input.sender)) &&
    state.wallets.every((wallet) => mine(wallet.owner))
  );
}
/** Reads version 2 (`wallets`) and version 1 (a single `granted`), so an owner who onboarded a
 *  wallet before the list existed still sees it and can still revoke it. */
export function loadGrantState(base: string, owner: string): GrantState {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key(base, owner)) ?? "null");
    if (!record(raw) || (raw.version !== 1 && raw.version !== 2)) return empty();
    const pending = raw.pending ?? null;
    if (pending !== null && !validPending(pending)) return empty();
    const listed: unknown[] =
      raw.version === 2
        ? Array.isArray(raw.wallets)
          ? raw.wallets
          : []
        : raw.granted
          ? [raw.granted]
          : [];
    if (!listed.every(validGranted)) return empty();
    const state: GrantState = { pending, wallets: listed };
    return belongs(state, owner) ? state : empty();
  } catch {
    return empty();
  }
}
export function saveGrantState(base: string, owner: string, state: GrantState): boolean {
  try {
    if (!belongs(state, owner)) return false;
    localStorage.setItem(key(base, owner), JSON.stringify({ version: 2, ...state }));
    return true;
  } catch {
    return false;
  }
}
