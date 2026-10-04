import { formatQuotedAmount } from "@/lib/swap-preview";
import { SignerPairing } from "@/components/signer-pairing";
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
} from "@mysten/dapp-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SiteHeader } from "@/components/site-chrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { baseUnitsToDecimal } from "@/lib/capabilities";
import {
  buildRevokeTx,
  decodeUnsignedPtb,
  harvestSetupObjects,
  isSelfOnboarding,
} from "@/lib/agent-wallet-tx";
import {
  rillApi,
  type GrantInput,
  type PreparedGrant,
  type PublishedSkillSummary,
  type SetupPlan,
  type SetupInput,
  type SwapFundingPreview,
  type PairedAgent,
} from "@/lib/rill-api";
import { defaultPairedAgent } from "@/lib/signer-pairing";
import { SUI_NETWORK } from "@/lib/sui-network";
import { ensureSession } from "@/lib/rill-session";
import { executeSigned, waitForOutcome } from "@/lib/sui-chain";

/**
 * Grant an agent a bounded on-chain wallet: the one place a human approves anything in Rill.
 *
 * The whole point of this page is the separation it creates. `agent_wallet` reserves `revoke`,
 * `add_rule`, `remove_rule` and `rotate_agent` for the owner precisely so an agent cannot widen its
 * own limits: but that guard is vacuous if one key holds both roles, which is what the local
 * signer's self-onboarding path does. Here the OWNER is your browser wallet and the AGENT is the
 * local `rill-wallet` key, so the kill switch genuinely lives somewhere the agent cannot reach.
 *
 * Three signatures: create an empty wallet, attach capabilities and fund atomically, then sign the
 * action grant the agent's local signer runs under. The grant replaces copying a run-set file by
 * hand: the signer fetches it and uses it only after checking the owner's signature on chain.
 */
export const Route = createFileRoute("/agent-wallet")({
  head: () => ({
    meta: [
      { title: "Agent wallet: Rill" },
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
  const currentOwner = useRef(ownerAddress);
  currentOwner.current = ownerAddress;
  const [pairedAgents, setPairedAgents] = useState<PairedAgent[]>([]);
  // The wallet signs; submission and confirmation go over gRPC, because public fullnodes no longer
  // serve the JSON-RPC that dapp-kit would otherwise use. See lib/sui-chain.ts.
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction({ execute: executeSigned });
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
  const [wallets, setWallets] = useState<Granted[]>([]);
  const [restoredOwner, setRestoredOwner] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedGrant | null>(null);
  const [existingWallet, setExistingWallet] = useState("");
  const [quotePreview, setQuotePreview] = useState<{
    key: string;
    value: SwapFundingPreview | null;
  } | null>(null);
  const previewKey = JSON.stringify([
    ownerAddress,
    skillId,
    agent,
    budgetSui,
    perTxSui,
    expiryHours,
    price,
  ]);
  const currentPreview = quotePreview?.key === previewKey ? quotePreview.value : null;
  useEffect(() => {
    const recovered = ownerAddress
      ? loadGrantState(rillApi.baseUrl, ownerAddress)
      : { pending: null, wallets: [] };
    setPending(recovered.pending);
    setWallets(recovered.wallets);
    setRestoredOwner(ownerAddress ?? null);
  }, [ownerAddress]);
  useEffect(() => {
    if (!ownerAddress || restoredOwner !== ownerAddress) return;
    if (pending && pending.input.sender !== ownerAddress) return;
    if (wallets.some((wallet) => wallet.owner !== ownerAddress)) return;
    if (!saveGrantState(rillApi.baseUrl, ownerAddress, { pending, wallets })) {
      toast.error(
        "Browser storage is unavailable. Keep this page open until you download the grant files.",
      );
    }
  }, [ownerAddress, restoredOwner, pending, wallets]);

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
      const [actions, pairing] = await Promise.allSettled([
        rillApi.skills(session.accessToken),
        rillApi.pairedAgents(session.accessToken),
      ]);
      if (currentOwner.current !== account.address) return;
      if (actions.status === "rejected") throw actions.reason;
      const list = actions.value;
      if (pairing.status === "fulfilled") {
        setPairedAgents(pairing.value);
        setAgent((selected) =>
          defaultPairedAgent(pairing.value, account.address, SUI_NETWORK, selected),
        );
      }
      setSkills(list);
      if (list.length > 0) setSkillId((current) => current || list[0].id);
      if (list.length === 0)
        toast.message("No published actions yet", {
          description: "Publish a flow in the builder first: a wallet is granted per action.",
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
    setAgent("");
    setPairedAgents([]);
  }, [account?.address]);

  /** Create an empty wallet first. No funds are granted until rules are attached. */
  async function grant(previewOnly = false) {
    if (!account || busy || pending) return;
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
      const quoted = await rillApi.previewSetup(input, undefined, session.accessToken);
      setQuotePreview({ key: previewKey, value: quoted.swapPreview });
      if (previewOnly) {
        if (!quoted.swapPreview) toast.message("This action has no single-swap preview.");
        return;
      }
      if (quoted.swapPreview && !quoted.swapPreview.outputFloorMet) {
        toast.error(
          "The current quote is below the published minimum output. Increase your input cap or publish a different floor before funding.",
        );
        return;
      }
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
      const confirmed = await waitForOutcome(pending.digest);
      if (confirmed.status !== "success") {
        setPending(null);
        throw new Error(confirmed.error ?? "The empty-wallet transaction did not succeed.");
      }
      const objects = harvestSetupObjects(confirmed.objectChanges, pending.plan.requiresTradeCap);
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
      const receipt = await waitForOutcome(attachment.digest);
      if (receipt.status !== "success") {
        setPending({ ...pending, attachment: undefined });
        throw new Error(receipt.error ?? "Funding did not succeed.");
      }
      const onboarded: Granted = {
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
        actionId: pending.input.skillId,
        budgetMist: pending.input.budgetMist,
        perTxMist: pending.input.perTxMist,
        expiresAtMs: pending.input.expiresAtMs,
      };
      setWallets((list) => [
        onboarded,
        ...list.filter((wallet) => wallet.walletId !== onboarded.walletId),
      ]);
      setPending(null);
      toast.success("Wallet configured and funded", {
        description: "One more signature grants the action to your agent.",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Configuring the wallet failed.");
    } finally {
      setBusy(null);
    }
  }

  /** The grant request for a wallet onboarded on this page, from what the owner entered then. */
  function grantInputForGranted(granted: Granted): GrantInput | null {
    const runSet = granted.runSet as {
      actionId?: string;
      maxAmountBaseUnits?: string;
      capabilityManifest?: { rules?: { kind?: string; totalMist?: string }[] };
    };
    const budget =
      granted.budgetMist ??
      runSet.capabilityManifest?.rules?.find((rule) => rule.kind === "budget")?.totalMist;
    const perTx = granted.perTxMist ?? runSet.maxAmountBaseUnits;
    const actionId = granted.actionId ?? runSet.actionId;
    if (!budget || !perTx || !actionId) return null;
    return {
      actionId,
      walletId: granted.walletId,
      budgetMist: budget,
      perTxMist: perTx,
      expiresAtMs: granted.expiresAtMs,
      // A DeepBook wallet's grant needs the manager and capabilities onboarding bound it to; the
      // server refused one without them.
      balanceManagerId: granted.balanceManagerId,
      tradeCapId: granted.tradeCapId,
      depositCapId: granted.depositCapId,
    };
  }

  /** The grant request for a wallet funded elsewhere, from this form's action and limits. */
  function grantInputForExisting(): GrantInput | null {
    const budgetMist = suiToMist(budgetSui);
    const perTxMist = suiToMist(perTxSui);
    const hours = Number(expiryHours);
    if (!/^0x[0-9a-fA-F]{64}$/.test(existingWallet.trim())) {
      toast.error("Wallet id must be a full Sui object id.");
      return null;
    }
    if (!skillId || budgetMist === null || perTxMist === null || !Number.isFinite(hours)) {
      toast.error("Choose an action and set the budget, per-tx max and expiry above.");
      return null;
    }
    return {
      actionId: skillId,
      walletId: existingWallet.trim(),
      budgetMist: budgetMist.toString(),
      perTxMist: perTxMist.toString(),
      expiresAtMs: String(Date.now() + hours * 60 * 60 * 1000),
    };
  }

  /** Ask the server for the grant and the exact text to sign. Nothing is signed here. */
  async function prepareActionGrant(input: GrantInput | null) {
    if (!account || !input || busy) return;
    setBusy("Preparing the grant…");
    try {
      const session = await ensureSession(account.address, async (message) => {
        const { signature } = await signPersonalMessage({ message });
        return signature;
      });
      setPrepared(await rillApi.prepareGrant(input, undefined, session.accessToken));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Preparing the grant failed.");
    } finally {
      setBusy(null);
    }
  }

  /** Sign the prepared grant's message verbatim and store it for the agent's signer. */
  async function signActionGrant() {
    if (!account || !prepared || busy) return;
    setBusy("Waiting for your wallet…");
    try {
      const { signature } = await signPersonalMessage({
        message: new TextEncoder().encode(prepared.message),
      });
      const session = await ensureSession(account.address, async (message) => {
        const { signature } = await signPersonalMessage({ message });
        return signature;
      });
      setBusy("Storing the grant…");
      const stored = await rillApi.storeGrant(
        { grant: prepared.grant, signature },
        undefined,
        session.accessToken,
      );
      setWallets((list) =>
        list.map((wallet) =>
          wallet.walletId === prepared.grant.walletId
            ? { ...wallet, grantRevision: stored.revision }
            : wallet,
        ),
      );
      toast.success(`Granted to your agent (revision ${stored.revision})`, {
        description: "Ask your agent to list its Rill actions; it can run this one now.",
      });
      setPrepared(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Signing the grant failed.");
    } finally {
      setBusy(null);
    }
  }

  function downloadArtifact(granted: Granted, kind: "runSet" | "buildArguments") {
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
  async function revoke(granted: Granted) {
    if (!account || busy || account.address !== granted.owner) return;
    setBusy("Waiting for your wallet…");
    try {
      const result = await signAndExecute({
        transaction: buildRevokeTx({
          walletPackageId: granted.walletPackageId,
          walletId: granted.walletId,
          owner: account.address,
        }),
      });
      const receipt = await waitForOutcome(result.digest);
      if (receipt.status !== "success") {
        throw new Error(receipt.error ?? "Revocation did not succeed.");
      }
      toast.success("Revoked", { description: "The remaining budget is back in your wallet." });
      setWallets((list) => list.filter((wallet) => wallet.walletId !== granted.walletId));
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
        <h1 className="mt-2 font-display text-4xl tracking-tight">Connect your agent</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Choose your action and agent, then approve a spending budget. Your agent keeps its own
          signer and runs within your limits. Your browser wallet keeps control of revocation and
          reclaiming unused funds.
        </p>

        {!account ? (
          <div className="mt-8">
            <ConnectButton />
            <p className="mt-3 text-xs text-muted-foreground">
              Connect your wallet to approve budgets and reclaim unused funds. Your agent uses
              its own signer.
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
              {account && (
                <SignerPairing
                  key={account.address}
                  owner={account.address}
                  initialAgents={pairedAgents}
                  agent={agent}
                  onSelect={setAgent}
                  session={async () => {
                    const session = await ensureSession(account.address, async (message) => {
                      const { signature } = await signPersonalMessage({ message });
                      return signature;
                    });
                    return session.accessToken;
                  }}
                />
              )}
              {agent && selfOnboarding && (
                <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-500">
                  That is your own address. The wallet would still work, but the agent would hold
                  its own kill switch and could lift its own limits: use the local signer's address
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
                placeholder="leave empty to use the price the action was published with"
                className="mt-1.5"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                For DeepBook actions, the exact decimal price the order rests at. An ask below the
                market fills at once. Swap and stake actions do not need this field.
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

            {currentPreview && (
              <div
                className="space-y-2 rounded-xl border border-border p-4"
                aria-label="Swap funding preview"
              >
                <p className="text-sm font-medium">
                  {currentPreview.outputFloorMet
                    ? "Current quote meets your minimum"
                    : "Current quote is below your minimum"}
                </p>
                <p className="text-xs">
                  Input:{" "}
                  {formatQuotedAmount(currentPreview.inputCoinType, currentPreview.inputBaseUnits)}.
                  Fee included:{" "}
                  {formatQuotedAmount(currentPreview.inputCoinType, currentPreview.feeBaseUnits)}.
                </p>
                <p className="text-xs">
                  Expected output:{" "}
                  {formatQuotedAmount(
                    currentPreview.outputCoinType,
                    currentPreview.quotedOutputBaseUnits,
                  )}
                  . Published minimum:{" "}
                  {formatQuotedAmount(
                    currentPreview.outputCoinType,
                    currentPreview.minimumOutputBaseUnits,
                  )}
                  .
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  Output asset: {currentPreview.outputCoinType}
                </p>
                <p className="text-xs text-muted-foreground">{currentPreview.note}</p>
              </div>
            )}
            {prepared && (
              <div className="space-y-3 rounded-xl border border-primary/40 p-4">
                <div className="text-sm font-medium">Review the grant before signing</div>
                <p className="text-xs text-muted-foreground">
                  Your wallet signs exactly this text. Your agent's signer re-derives it from the
                  grant and checks your signature on chain, so nothing different can be run under
                  it.
                </p>
                <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">
                  {prepared.message}
                </pre>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={signActionGrant} disabled={Boolean(busy)}>
                    {busy ?? "Sign grant"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setPrepared(null)}
                    disabled={Boolean(busy)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

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
                {pending.plan.protection && (
                  <p className="text-xs text-emerald-600">
                    Protected swap: the contract restricts the pool and output asset, enforces
                    minimum output, and returns proceeds to your owner wallet. Unused input stays in
                    the vault.
                  </p>
                )}
                {!pending.attachment && (
                  <p className="text-xs text-muted-foreground">
                    Set when this wallet was created, not by the fields above:{" "}
                    {baseUnitsToDecimal(pending.input.budgetMist)} SUI budget,{" "}
                    {baseUnitsToDecimal(pending.input.perTxMist)} SUI per transaction.
                  </p>
                )}
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
                {/* Only before funding is submitted: the empty wallet holds nothing, so leaving it
                    unused costs nothing, and without this an owner whose limits the server refused
                    had no way to enter new ones. */}
                {!pending.attachment && (
                  <Button
                    variant="outline"
                    onClick={() => setPending(null)}
                    disabled={Boolean(busy)}
                    className="ml-2"
                  >
                    Start over
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <Button
                  variant="outline"
                  onClick={() => void grant(true)}
                  disabled={Boolean(busy) || !skillId || !agent}
                >
                  Preview before funding
                </Button>
                <Button onClick={() => void grant()} disabled={Boolean(busy) || !skillId || !agent}>
                  {busy ?? "Create empty wallet"}
                </Button>
                <details className="rounded-xl border border-border p-4 text-sm">
                  <summary className="cursor-pointer font-medium">
                    Already funded a wallet? Grant this action to it
                  </summary>
                  <div className="mt-3 space-y-3">
                    <Label htmlFor="existing-wallet">Wallet id</Label>
                    <Input
                      id="existing-wallet"
                      value={existingWallet}
                      onChange={(event) => setExistingWallet(event.target.value)}
                      placeholder="0x…: a wallet you own, already carrying its rules"
                      className="font-mono text-xs"
                    />
                    <p className="text-xs text-muted-foreground">
                      Uses the action, limits and expiry above. The agent is read from the wallet.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => prepareActionGrant(grantInputForExisting())}
                      disabled={Boolean(busy) || !skillId || !existingWallet}
                    >
                      Prepare grant
                    </Button>
                  </div>
                </details>
              </div>
            )}

            {wallets.length > 0 && (
              <div className="space-y-3">
                <div className="text-sm font-medium">Your agent wallets</div>
                {wallets.map((granted) => (
                  <div
                    key={granted.walletId}
                    className="space-y-4 rounded-xl border border-border p-4"
                  >
                    <div className="text-sm font-medium">
                      Funded wallet
                      {granted.actionId && (
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {granted.actionId}
                        </span>
                      )}
                    </div>
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
                    {granted.grantRevision ? (
                      <p className="text-sm text-emerald-600 dark:text-emerald-500">
                        Granted to your agent (revision {granted.grantRevision}). Ask it to list its
                        Rill actions and run this one.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground">
                          Last step: sign a grant so your agent's signer can run this action. It
                          only ever signs what this grant allows.
                        </p>
                        <Button
                          onClick={() => prepareActionGrant(grantInputForGranted(granted))}
                          disabled={
                            Boolean(busy) || Boolean(prepared) || account.address !== granted.owner
                          }
                        >
                          Grant this action to the agent
                        </Button>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={() => downloadArtifact(granted, "runSet")}>
                        Download run set (advanced)
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => downloadArtifact(granted, "buildArguments")}
                      >
                        Download build arguments
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => revoke(granted)}
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
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
