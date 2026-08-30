import { createFileRoute } from "@tanstack/react-router";
import {
  ConnectButton,
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSignPersonalMessage,
  useSuiClient,
} from "@mysten/dapp-kit";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { SiteHeader } from "@/components/site-chrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  buildMintTradeCapTx,
  buildRevokeTx,
  decodeUnsignedPtb,
  harvestSetupObjects,
  isSelfOnboarding,
  type ObjectChange,
} from "@/lib/agent-wallet-tx";
import { rillApi, type PublishedSkillSummary, type SetupPlan } from "@/lib/rill-api";
import { ensureSession } from "@/lib/rill-session";

/**
 * Grant an agent a bounded on-chain wallet — the one place a human approves anything in Rill.
 *
 * The whole point of this page is the separation it creates. `agent_wallet` reserves `revoke`,
 * `add_rule`, `remove_rule` and `rotate_agent` for the owner precisely so an agent cannot widen its
 * own limits — but that guard is vacuous if one key holds both roles, which is what the local
 * signer's self-onboarding path does. Here the OWNER is your browser wallet and the AGENT is the
 * local `rill-wallet` key, so the kill switch genuinely lives somewhere the agent cannot reach.
 *
 * Two signatures, once: create the wallet, then delegate trading. After that the agent transacts on
 * its own key with no approvals at all, bounded by what was granted here.
 */
export const Route = createFileRoute("/agent-wallet")({
  head: () => ({
    meta: [
      { title: "Agent wallet — Rill" },
      { name: "description", content: "Grant your agent a capped, revocable on-chain wallet." },
    ],
  }),
  component: AgentWalletPage,
});

const SUI_PER_MIST = 1_000_000_000n;

/** Human SUI → mist, through string/bigint only. No float ever touches an amount (KTD-2). */
function suiToMist(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,9})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return BigInt(whole) * SUI_PER_MIST + BigInt(fraction.padEnd(9, "0"));
}

type Granted = {
  walletId: string;
  agentCapId: string;
  balanceManagerId: string;
  tradeCapId?: string;
  walletPackageId: string;
  deepbookPackageId: string;
  agent: string;
  runSetTemplate: Record<string, unknown>;
  digest: string;
};

function AgentWalletPage() {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();

  const [skills, setSkills] = useState<PublishedSkillSummary[]>([]);
  const [skillId, setSkillId] = useState("");
  const [agent, setAgent] = useState("");
  const [budgetSui, setBudgetSui] = useState("1");
  const [perTxSui, setPerTxSui] = useState("0.2");
  const [expiryHours, setExpiryHours] = useState("24");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [granted, setGranted] = useState<Granted | null>(null);

  /** Load the signed-in address's own skills. Requires a session, since an ownerless listing would
   *  show skills this address cannot bind a wallet for. */
  const loadSkills = useCallback(async () => {
    if (!account) return;
    setBusy("Signing in…");
    try {
      const session = await ensureSession(account.address, async (message) => {
        const { signature } = await signPersonalMessage({ message });
        return signature;
      });
      const list = await rillApi.skills(session.accessToken);
      setSkills(list);
      if (list.length > 0) setSkillId((current) => current || list[0].id);
      if (list.length === 0) toast.message("No published actions yet", {
        description: "Publish a flow in the builder first — a wallet is granted per action.",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load your actions.");
    } finally {
      setBusy(null);
    }
  }, [account, signPersonalMessage]);

  useEffect(() => {
    setSkills([]);
    setGranted(null);
  }, [account?.address]);

  /** Step 1 — the owner signs `create_wallet`, funding it and naming the agent. */
  async function grant() {
    if (!account) return;
    const budgetMist = suiToMist(budgetSui);
    const perTxMist = suiToMist(perTxSui);
    if (budgetMist === null || perTxMist === null) {
      toast.error("Amounts must be plain decimals, up to 9 places.");
      return;
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(agent.trim())) {
      toast.error("Agent address must be a full 0x… Sui address — read it from the signer's signer_status tool.");
      return;
    }
    const hours = Number(expiryHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      toast.error("Expiry must be a positive number of hours.");
      return;
    }

    setBusy("Preparing…");
    try {
      const session = await ensureSession(account.address, async (message) => {
        const { signature } = await signPersonalMessage({ message });
        return signature;
      });
      const plan: SetupPlan = await rillApi.prepareSetup(
        {
          skillId,
          sender: account.address,
          agent: agent.trim(),
          budgetMist: budgetMist.toString(),
          perTxMist: perTxMist.toString(),
          expiresAtMs: String(Date.now() + hours * 60 * 60 * 1000),
          price: price.trim() === "" ? undefined : Number(price),
        },
        undefined,
        session.accessToken,
      );

      setBusy("Waiting for your wallet…");
      const result = await signAndExecute({ transaction: decodeUnsignedPtb(plan.setupPtb) });

      setBusy("Confirming on-chain…");
      const confirmed = await client.waitForTransaction({
        digest: result.digest,
        options: { showObjectChanges: true },
      });
      const harvested = harvestSetupObjects(confirmed.objectChanges as ObjectChange[] | undefined);
      if (harvested.missing.length > 0) {
        // Never fabricate ids: a run-set built from a guess points at objects that do not exist.
        throw new Error(
          `The wallet transaction succeeded (${result.digest}) but these objects were not found in `
          + `its effects: ${harvested.missing.join(", ")}.`,
        );
      }

      setGranted({
        walletId: harvested.walletId!,
        agentCapId: harvested.agentCapId!,
        balanceManagerId: harvested.balanceManagerId!,
        walletPackageId: plan.walletPackageId,
        deepbookPackageId: plan.deepbookPackageId,
        agent: plan.agent,
        runSetTemplate: plan.runSetTemplate,
        digest: result.digest,
      });
      toast.success("Agent wallet created", { description: "One more signature delegates trading." });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Granting the wallet failed.");
    } finally {
      setBusy(null);
    }
  }

  /** Step 2 — mint the TradeCap from the new BalanceManager and hand it to the agent. Built here
   *  from ids we just observed on-chain, never from server bytes carrying a placeholder. */
  async function delegateTrading() {
    if (!account || !granted) return;
    setBusy("Waiting for your wallet…");
    try {
      const result = await signAndExecute({
        transaction: buildMintTradeCapTx({
          deepbookPackageId: granted.deepbookPackageId,
          balanceManagerId: granted.balanceManagerId,
          agent: granted.agent,
        }),
      });
      const confirmed = await client.waitForTransaction({
        digest: result.digest,
        options: { showObjectChanges: true },
      });
      const tradeCapId = (confirmed.objectChanges as ObjectChange[] | undefined)
        ?.find((change) => change.type === "created" && change.objectType?.includes("::balance_manager::TradeCap"))
        ?.objectId;
      if (!tradeCapId) throw new Error(`TradeCap not found in the effects of ${result.digest}.`);
      setGranted({ ...granted, tradeCapId });
      toast.success("Trading delegated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delegating trading failed.");
    } finally {
      setBusy(null);
    }
  }

  /** The kill switch. Owner-only on-chain, which is exactly why it lives on this page. */
  async function revoke() {
    if (!account || !granted) return;
    setBusy("Waiting for your wallet…");
    try {
      const result = await signAndExecute({
        transaction: buildRevokeTx({
          walletPackageId: granted.walletPackageId,
          walletId: granted.walletId,
          owner: account.address,
        }),
      });
      await client.waitForTransaction({ digest: result.digest });
      toast.success("Revoked", { description: "The remaining budget is back in your wallet." });
      setGranted(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Revoking failed.");
    } finally {
      setBusy(null);
    }
  }

  const selfOnboarding = account ? isSelfOnboarding(account.address, agent || account.address) : false;

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <section className="mx-auto max-w-2xl px-6 pt-14 pb-24">
        <div className="text-xs uppercase tracking-widest text-muted-foreground">Agent wallet</div>
        <h1 className="mt-2 font-display text-4xl tracking-tight">Grant a bounded budget</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Two signatures, once. After this your agent transacts on its own local key with no
          approvals at all — every spend bounded on-chain by the budget and per-transaction cap you
          set here, and revocable by you at any time. Your wallet is not asked to sign anything the
          agent does afterwards.
        </p>

        {!account ? (
          <div className="mt-8">
            <ConnectButton />
            <p className="mt-3 text-xs text-muted-foreground">
              Connect the wallet that should OWN the budget. It keeps the kill switch; the agent
              never gets it.
            </p>
          </div>
        ) : (
          <div className="mt-8 space-y-5">
            <div>
              <div className="flex items-center justify-between gap-3">
                <Label>Action</Label>
                <button onClick={loadSkills} className="cursor-pointer text-xs underline text-muted-foreground">
                  {skills.length > 0 ? "Reload" : "Load my published actions"}
                </button>
              </div>
              <select
                value={skillId}
                onChange={(event) => setSkillId(event.target.value)}
                className="mt-1.5 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {skills.length === 0 && <option value="">— load your actions first —</option>}
                {skills.map((skill) => (
                  <option key={skill.id} value={skill.id}>{skill.name} · {skill.id}</option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="agent">Agent address</Label>
              <Input
                id="agent"
                value={agent}
                onChange={(event) => setAgent(event.target.value)}
                placeholder="0x… — run signer_status in your agent to read it"
                className="mt-1.5 font-mono text-xs"
              />
              {agent && selfOnboarding && (
                <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-500">
                  That is your own address. The wallet would still work, but the agent would hold its
                  own kill switch and could lift its own limits — use the local signer's address
                  instead.
                </p>
              )}
            </div>

            <div>
              <Label htmlFor="price">Onboarding order price (optional)</Label>
              <Input
                id="price"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                placeholder="leave empty to use twice the live mid price"
                className="mt-1.5"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                Onboarding places one deliberately-far order that should never fill. Its price comes
                from the live mid by default — but most DeepBook testnet pools have an empty book and
                no mid price, and then this is required. Set it well above the market.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label htmlFor="budget">Budget (SUI)</Label>
                <Input id="budget" value={budgetSui} onChange={(e) => setBudgetSui(e.target.value)} className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="pertx">Per-tx max (SUI)</Label>
                <Input id="pertx" value={perTxSui} onChange={(e) => setPerTxSui(e.target.value)} className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="expiry">Expires in (h)</Label>
                <Input id="expiry" value={expiryHours} onChange={(e) => setExpiryHours(e.target.value)} className="mt-1.5" />
              </div>
            </div>

            {!granted ? (
              <Button onClick={grant} disabled={Boolean(busy) || !skillId || !agent}>
                {busy ?? "Create agent wallet"}
              </Button>
            ) : (
              <div className="space-y-4 rounded-xl border border-border p-4">
                <div className="text-sm font-medium">Granted</div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
                  <dt className="text-muted-foreground">wallet</dt><dd className="break-all">{granted.walletId}</dd>
                  <dt className="text-muted-foreground">agentCap</dt><dd className="break-all">{granted.agentCapId}</dd>
                  <dt className="text-muted-foreground">manager</dt><dd className="break-all">{granted.balanceManagerId}</dd>
                  <dt className="text-muted-foreground">tradeCap</dt>
                  <dd className="break-all">{granted.tradeCapId ?? "— not delegated yet —"}</dd>
                </dl>
                <div className="flex flex-wrap gap-2">
                  {!granted.tradeCapId && (
                    <Button onClick={delegateTrading} disabled={Boolean(busy)}>
                      {busy ?? "Delegate trading"}
                    </Button>
                  )}
                  <Button variant="outline" onClick={revoke} disabled={Boolean(busy)}>
                    Revoke &amp; reclaim
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Revoking marks the wallet revoked on-chain and returns the remaining budget to you.
                  The agent's next attempt fails before it ever signs.
                </p>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
