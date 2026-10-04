import type { Granted } from "./grant-storage";

export type AgentWorkflow = {
  runId: string;
  network: string;
  signer: string;
  owner: string;
  steps: { actionId: string; walletId: string; revision: number }[];
};
const address = (value: unknown): string => {
  if (typeof value !== "string" || !/^0x[0-9a-f]{1,64}$/i.test(value)) {
    throw new Error("A valid owner, signer and vault address are required.");
  }
  return value.slice(2).toLowerCase().padStart(64, "0");
};
/** Public grant references only. The signer verifies every exact grant on chain before spending. */
export function buildAgentWorkflow(
  grants: Granted[],
  owner: string,
  network: string,
  runId: string,
): AgentWorkflow {
  if (grants.length < 1 || grants.length > 10) throw new Error("Choose 1 to 10 approved budgets.");
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(runId)) throw new Error("Invalid workflow run ID.");
  if (!["mainnet", "testnet"].includes(network)) throw new Error("Unsupported network.");
  const signer = grants[0].runSet.sender;
  const seen = new Set<string>();
  const steps = grants.map((grant) => {
    const actionId = grant.actionId ?? grant.runSet.actionId;
    if (
      typeof actionId !== "string" ||
      !actionId ||
      !Number.isSafeInteger(grant.grantRevision) ||
      !grant.grantRevision ||
      grant.grantRevision < 1
    ) {
      throw new Error("Approve agent access for every selected budget first.");
    }
    if (address(grant.owner) !== address(owner))
      throw new Error("Select budgets belonging to this wallet.");
    if (grant.runSet.network !== network || address(grant.runSet.sender) !== address(signer)) {
      throw new Error("All steps must use the same agent signer and network.");
    }
    const wallet = address(grant.walletId);
    if (seen.has(wallet)) throw new Error("Select each vault only once.");
    seen.add(wallet);
    return { actionId, walletId: grant.walletId, revision: grant.grantRevision };
  });
  return { runId, network, signer: signer as string, owner, steps };
}
