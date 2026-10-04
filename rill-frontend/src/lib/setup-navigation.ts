export type SetupStep = "action" | "agent" | "budget" | "approve";
export const SETUP_STEPS: SetupStep[] = ["action", "agent", "budget", "approve"];
export function canVisitSetupStep(
  step: SetupStep,
  action: string,
  agent: string,
  committed: boolean,
  owner?: string,
  readiness?: { hasActionOptions: boolean; budgetIsValid: boolean },
): boolean {
  if (committed) return step === "approve";
  if (step === "action") return true;
  if (!action) return false;
  if (readiness?.hasActionOptions === false) return false;
  if (step === "agent") return true;
  if (step === "approve" && readiness?.budgetIsValid === false) return false;
  return (
    /^0x[0-9a-fA-F]{64}$/.test(agent.trim()) && agent.trim().toLowerCase() !== owner?.toLowerCase()
  );
}
export function shortAddress(value: string): string {
  return value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

const SUI_SCALE = 1_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;
export function suiToMist(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,9})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const amount = BigInt(whole) * SUI_SCALE + BigInt(fraction.padEnd(9, "0"));
  return amount <= U64_MAX ? amount : null;
}
export function budgetFormError(
  budget: string,
  perRun: string,
  expiry: string,
  limits?: { budgetLimitMist: string | null; perTxLimitMist: string | null } | null,
): string | null {
  const total = suiToMist(budget),
    single = suiToMist(perRun);
  if (total === null || single === null || total <= 0n || single <= 0n)
    return "Enter positive SUI amounts with up to 9 decimal places.";
  if (single > total) return "The maximum per run cannot exceed the total budget.";
  if (limits?.budgetLimitMist && total > BigInt(limits.budgetLimitMist))
    return "The total budget exceeds this action's published limit.";
  if (limits?.perTxLimitMist && single > BigInt(limits.perTxLimitMist))
    return "The maximum per run exceeds this action's published limit.";
  const hours = Number(expiry);
  if (
    !Number.isFinite(hours) ||
    hours <= 0 ||
    !Number.isSafeInteger(Date.now() + hours * 3_600_000)
  )
    return "Enter a positive, valid number of hours.";
  return null;
}
