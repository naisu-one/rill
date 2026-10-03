import {
  loadGrantState,
  saveGrantState,
  type PendingSetup,
  type Granted,
} from "@/lib/grant-storage";
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
  buildRevokeTx,
  decodeUnsignedPtb,
  harvestSetupObjects,
  isSelfOnboarding,
  type ObjectChange,
} from "@/lib/agent-wallet-tx";
import {
  rillApi,
  type PublishedSkillSummary,
  type SetupPlan,
  type SetupInput,
} from "@/lib/rill-api";
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
 * Two signatures: create an empty wallet, then attach capabilities and fund atomically.
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

function AgentWalletPage() {
  const account = useCurrentAccount();
  const ownerAddress = account?.address;
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();

  const [skills, setSkills] = useState<PublishedSkillSummary[]>([]);
  const [skillId, setSkillId] = useState("");
  const [agent, setAgent] = useState("");
  const [budgetSui, setBudgetSui] = useState("1");
  const [perTxSui, setPerTxSui] = useState("1");
  const [expiryHours, setExpiryHours] = useState("24");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSetup | null>(null);
  const [granted, setGranted] = useState<Granted | null>(null);
  const [restoredOwner, setRestoredOwner] = useState<string | null>(null);
  useEffect(() => {
    const recovered = ownerAddress
      ? loadGrantState(rillApi.baseUrl, ownerAddress)
      : { pending: null, granted: null };
    setPending(recovered.pending);
    setGranted(recovered.granted);
    setRestoredOwner(ownerAddress ?? null);
  }, [ownerAddress]);
  useEffect(() => {
    if (!ownerAddress || restoredOwner !== ownerAddress) return;
    if (pending && pending.input.sender !== ownerAddress) return;
    if (granted && granted.owner !== ownerAddress) return;
    if (!saveGrantState(rillApi.baseUrl, ownerAddress, { pending, granted })) {
      toast.error(
        "Browser storage is unavailable. Keep this page open until you download the grant files.",
      );
    }
  }, [ownerAddress, restoredOwner, pending, granted]);

  /** Load the signed-in address's own skills. Requires a session, since an ownerless listing would
   *  show skills this address cannot bind a wallet for. */
  const loadSkills = useCallback(async () => {
    if (!account || busy) return;
    setBusy("Signing in…");
    try {
      const session = await ensureSession(account.address, async (message) => {
        const { signature } = await signPersonalMessage({ message });
        return signature;
      });
      const list = await rillApi.skills(session.accessToken);
      setSkills(list);
      if (list.length > 0) setSkillId((current) => current || list[0].id);
      if (list.length === 0)
        toast.message("No published actions yet", {
          description: "Publish a flow in the builder first — a wallet is granted per action.",
        });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load your actions.");
    } finally {
      setBusy(null);
    }
  }, [account, busy, signPersonalMessage]);

  useEffect(() => {
    setSkills([]);
    setSkillId("");
  }, [account?.address]);

  /** Create an empty wallet first. No funds are granted until rules are attached. */
  async function grant() {
    if (!account || busy || pending || granted) return;
    const budgetMist = suiToMist(budgetSui);
    const perTxMist = suiToMist(perTxSui);
    if (budgetMist === null || perTxMist === null || budgetMist <= 0n || perTxMist <= 0n) {
      toast.error("Amounts must be positive plain decimals, up to 9 places.");
      return;
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(agent.trim())) {
      toast.error("Agent address must be a full Sui address from the signer's signer_status tool.");
      return;
    }
    const exactPrice = price.trim();
    if (exactPrice && (!/^\d+(\.\d+)?$/.test(exactPrice) || !/[1-9]/.test(exactPrice))) {
      toast.error("Price must be a positive plain decimal.");
      return;
    }
    const hours = Number(expiryHours);
    const expiresAtMs = Date.now() + hours * 60 * 60 * 1000;
    if (!Number.isFinite(hours) || hours <= 0 || !Number.isSafeInteger(expiresAtMs)) {
      toast.error("Expiry must be a positive number of hours with a valid timestamp.");
      return;
    }
    const input: SetupInput = {
      skillId,
      sender: account.address,
      agent: agent.trim(),
      budgetMist: budgetMist.toString(),
      perTxMist: perTxMist.toString(),
      expiresAtMs: String(expiresAtMs),
      price: exactPrice || undefined,
    };
    setBusy("Preparing empty wallet…");
    try {
      const session = await ensureSession(account.address, async (message) => {
        const { signature } = await signPersonalMessage({ message });
        return signature;
      });
      const plan = await rillApi.prepareSetup(input, undefined, session.accessToken);
      setBusy("Waiting for your wallet…");
      const result = await signAndExecute({ transaction: decodeUnsignedPtb(plan.setupPtb) });
      setPending({ input, plan, digest: result.digest });
      toast.success("Empty wallet submitted", {
        description: "Configure and fund it next. Until then, no spending budget is granted.",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Creating the wallet failed.");
    } finally {
      setBusy(null);
    }
  }

  /** Attach every rule and fund atomically; a rejected signature leaves an empty wallet. */
  async function attachAndFund() {
    if (!account || !pending || busy) return;
    if (account.address !== pending.input.sender) {
      toast.error("Reconnect the wallet that created this pending setup.");
      return;
    }
    setBusy("Confirming empty wallet…");
    try {
      const confirmed = await client.waitForTransaction({
        digest: pending.digest,
        options: { showObjectChanges: true, showEffects: true },
      });
      if (confirmed.effects?.status.status !== "success") {
        if (confirmed.effects?.status.status === "failure") setPending(null);
        throw new Error(
          confirmed.effects?.status.error ?? "The empty-wallet transaction did not succeed.",
        );
      }
      const objects = harvestSetupObjects(
        confirmed.objectChanges as ObjectChange[] | undefined,
        pending.plan.requiresTradeCap,
      );
      if (objects.missing.length > 0) {
        throw new Error(`Setup ${pending.digest} did not return: ${objects.missing.join(", ")}.`);
      }
      let attachment = pending.attachment;
      if (!attachment) {
        const session = await ensureSession(account.address, async (message) => {
          const { signature } = await signPersonalMessage({ message });
          return signature;
        });
        setBusy("Preparing rules and funding…");
        const attached = await rillApi.attachSetup(
          {
            ...pending.input,
            walletId: objects.walletId!,
            agentCapId: objects.agentCapId!,
            ...(pending.plan.requiresTradeCap
              ? {
                  balanceManagerId: objects.balanceManagerId,
                  tradeCapId: objects.tradeCapId,
                  depositCapId: objects.depositCapId,
                }
              : {}),
          },
          undefined,
          session.accessToken,
        );
        setBusy("Waiting for your wallet…");
        const result = await signAndExecute({ transaction: decodeUnsignedPtb(attached.attachPtb) });
        attachment = {
          digest: result.digest,
          runSet: attached.runSet,
          buildArguments: attached.buildArguments,
        };
        setPending({ ...pending, attachment });
      }
      setBusy("Confirming rules and funding…");
      const receipt = await client.waitForTransaction({
        digest: attachment.digest,
        options: { showEffects: true },
      });
      if (receipt.effects?.status.status !== "success") {
        if (receipt.effects?.status.status === "failure") {
          setPending({ ...pending, attachment: undefined });
        }
        throw new Error(
          receipt.effects?.status.error ?? "Funding is not confirmed yet. Check its status again.",
        );
      }
      setGranted({
        walletId: objects.walletId!,
        agentCapId: objects.agentCapId!,
        balanceManagerId: objects.balanceManagerId,
        tradeCapId: objects.tradeCapId,
        depositCapId: objects.depositCapId,
        walletPackageId: pending.plan.walletPackageId,
        owner: pending.input.sender,
        runSet: attachment.runSet,
        buildArguments: attachment.buildArguments,
        digest: attachment.digest,
      });
      setPending(null);
      toast.success("Wallet configured and funded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Configuring the wallet failed.");
    } finally {
      setBusy(null);
    }
  }

  function downloadArtifact(kind: "runSet" | "buildArguments") {
    if (!granted) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(granted[kind], null, 2) + "\n"], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = kind === "runSet" ? "rill-run-set.json" : "rill-build-arguments.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  /** The kill switch. Owner-only on-chain, which is exactly why it lives on this page. */
  async function revoke() {
    if (!account || !granted || account.address !== granted.owner) return;
    setBusy("Waiting for your wallet…");
    try {
      const result = await signAndExecute({
        transaction: buildRevokeTx({
          walletPackageId: granted.walletPackageId,
          walletId: granted.walletId,
          owner: account.address,
        }),
      });
      const receipt = await client.waitForTransaction({
        digest: result.digest,
        options: { showEffects: true },
      });
      if (receipt.effects?.status.status !== "success") {
        throw new Error(receipt.effects?.status.error ?? "Revocation is not confirmed yet.");
      }
      toast.success("Revoked", { description: "The remaining budget is back in your wallet." });
      setGranted(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Revoking failed.");
    } finally {
      setBusy(null);
    }
  }

  const selfOnboarding = account
    ? isSelfOnboarding(account.address, agent || account.address)
    : false;

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <section className="mx-auto max-w-2xl px-6 pt-14 pb-24">
        <div className="text-xs uppercase tracking-widest text-muted-foreground">Agent wallet</div>
        <h1 className="mt-2 font-display text-4xl tracking-tight">Grant a bounded budget</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          First create an empty wallet, then attach its capabilities and fund it in one transaction.
          After both signatures, your agent can spend within the granted limits. You keep the
          ability to revoke the wallet and reclaim its remaining budget.
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
                <button
                  onClick={loadSkills}
                  disabled={Boolean(busy)}
                  className="cursor-pointer text-xs underline text-muted-foreground"
                >
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
                  <option key={skill.id} value={skill.id}>
                    {skill.name} · {skill.id}
                  </option>
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
                  That is your own address. The wallet would still work, but the agent would hold
                  its own kill switch and could lift its own limits — use the local signer's address
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
                For DeepBook actions, provide the exact decimal order price when the testnet order
                book has no live mid price. Swap and stake actions do not need this field.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label htmlFor="budget">Budget (SUI)</Label>
                <Input
                  id="budget"
                  value={budgetSui}
                  onChange={(e) => setBudgetSui(e.target.value)}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="pertx">Per-tx max (SUI)</Label>
                <Input
                  id="pertx"
                  value={perTxSui}
                  onChange={(e) => setPerTxSui(e.target.value)}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="expiry">Expires in (h)</Label>
                <Input
                  id="expiry"
                  value={expiryHours}
                  onChange={(e) => setExpiryHours(e.target.value)}
                  className="mt-1.5"
                />
              </div>
            </div>

            {pending ? (
              <div className="space-y-3 rounded-xl border border-border p-4">
                <div className="text-sm font-medium">
                  {pending.attachment ? "Funding submitted" : "Empty wallet pending configuration"}
                </div>
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {pending.attachment?.digest ?? pending.digest}
                </p>
                <p className="text-xs text-muted-foreground">
                  {pending.attachment
                    ? "Check the submitted transaction before downloading your run set. No further signature is needed."
                    : "The next signature attaches capabilities and funds the wallet. If you cancel, it keeps no spending budget. Retry this step to continue."}
                </p>
                {account.address !== pending.input.sender && (
                  <p className="text-xs text-amber-600">
                    Reconnect {pending.input.sender} to continue.
                  </p>
                )}
                <Button
                  onClick={attachAndFund}
                  disabled={Boolean(busy) || account.address !== pending.input.sender}
                >
                  {busy ??
                    (pending.attachment ? "Check funding status" : "Configure & fund wallet")}
                </Button>
              </div>
            ) : !granted ? (
              <Button onClick={grant} disabled={Boolean(busy) || !skillId || !agent}>
                {busy ?? "Create empty wallet"}
              </Button>
            ) : (
              <div className="space-y-4 rounded-xl border border-border p-4">
                <div className="text-sm font-medium">Granted</div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
                  <dt className="text-muted-foreground">wallet</dt>
                  <dd className="break-all">{granted.walletId}</dd>
                  <dt className="text-muted-foreground">agentCap</dt>
                  <dd className="break-all">{granted.agentCapId}</dd>
                  {granted.balanceManagerId && (
                    <>
                      <dt className="text-muted-foreground">manager</dt>
                      <dd className="break-all">{granted.balanceManagerId}</dd>
                    </>
                  )}
                  {granted.tradeCapId && (
                    <>
                      <dt className="text-muted-foreground">tradeCap</dt>
                      <dd className="break-all">{granted.tradeCapId}</dd>
                    </>
                  )}
                  {granted.depositCapId && (
                    <>
                      <dt className="text-muted-foreground">depositCap</dt>
                      <dd className="break-all">{granted.depositCapId}</dd>
                    </>
                  )}
                </dl>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => downloadArtifact("runSet")}>Download run set</Button>
                  <Button variant="outline" onClick={() => downloadArtifact("buildArguments")}>
                    Download build arguments
                  </Button>
                  <Button
                    variant="outline"
                    onClick={revoke}
                    disabled={Boolean(busy) || account.address !== granted.owner}
                  >
                    Revoke &amp; reclaim
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Revoking marks the wallet revoked on-chain and returns the remaining budget to
                  you. The agent's next attempt fails before it ever signs.
                </p>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
