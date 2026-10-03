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
};

export type GrantState = { pending: PendingSetup | null; granted: Granted | null };

const empty = (): GrantState => ({ pending: null, granted: null });
function key(base: string, owner: string): string {
  const networkSuffix = SUI_NETWORK === "testnet" ? "" : `:${SUI_NETWORK}`;
  return `rill:grant:v1:${encodeURIComponent(base)}:${owner.toLowerCase()}${networkSuffix}`;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function belongs(state: GrantState, owner: string): boolean {
  return (
    (!state.pending || state.pending.input.sender.toLowerCase() === owner.toLowerCase()) &&
    (!state.granted || state.granted.owner.toLowerCase() === owner.toLowerCase())
  );
}
export function loadGrantState(base: string, owner: string): GrantState {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key(base, owner)) ?? "null");
    if (!record(raw) || raw.version !== 1) return empty();
    const pending = raw.pending;
    const granted = raw.granted;
    if (
      pending !== null &&
      (!record(pending) ||
        typeof pending.digest !== "string" ||
        !record(pending.input) ||
        typeof pending.input.sender !== "string" ||
        !record(pending.plan) ||
        typeof pending.plan.setupPtb !== "string")
    )
      return empty();
    if (
      granted !== null &&
      (!record(granted) ||
        typeof granted.owner !== "string" ||
        typeof granted.digest !== "string" ||
        !record(granted.runSet) ||
        !record(granted.buildArguments))
    )
      return empty();
    if (
      record(pending) &&
      pending.attachment !== undefined &&
      (!record(pending.attachment) ||
        typeof pending.attachment.digest !== "string" ||
        !record(pending.attachment.runSet) ||
        !record(pending.attachment.buildArguments))
    )
      return empty();
    const state = { pending, granted } as GrantState;
    return belongs(state, owner) ? state : empty();
  } catch {
    return empty();
  }
}
export function saveGrantState(base: string, owner: string, state: GrantState): boolean {
  try {
    if (!belongs(state, owner)) return false;
    localStorage.setItem(key(base, owner), JSON.stringify({ version: 1, ...state }));
    return true;
  } catch {
    return false;
  }
}
