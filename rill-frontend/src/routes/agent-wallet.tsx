import { WalletControl } from "@/components/wallet-control";
import { formatQuotedAmount } from "@/lib/swap-preview";
import { SignerPairing } from "@/components/signer-pairing";
import {
  loadGrantState,
  saveGrantState,
  type PendingSetup,
  type Granted,
} from "@/lib/grant-storage";
import {
  BudgetSummary,
  SetupJourney,
  SetupNext,
  SummaryItem,
} from "@/components/agent-wallet/setup-journey";
import {
  budgetFormError,
  suiToMist,
  canVisitSetupStep,
  shortAddress,
  type SetupStep,
} from "@/lib/setup-navigation";
import { Bot, Plus, ShieldCheck, Wallet, ArrowRight } from "lucide-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
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
  type SetupOptions,
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
  validateSearch: (search: { action?: unknown }) => ({
    action: typeof search.action === "string" ? search.action : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Agent wallet: Rill" },
      { name: "description", content: "Grant your agent a capped, revocable on-chain wallet." },
    ],
  }),
  component: AgentWalletPage,
});

function AgentWalletPage() {
  const { action: requestedAction } = Route.useSearch();
  const account = useCurrentAccount();
  const ownerAddress = account?.address;
  const currentOwner = useRef(ownerAddress);
  currentOwner.current = ownerAddress;
  const [pairedAgents, setPairedAgents] = useState<PairedAgent[]>([]);
  // The wallet signs; submission and confirmation go over gRPC, because public fullnodes no longer
  // serve the JSON-RPC that dapp-kit would otherwise use. See lib/sui-chain.ts.
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction({ execute: executeSigned });
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();

  const [actionOptions, setActionOptions] = useState<SetupOptions | null>(null);
  const selectedActionRef = useRef("");
  const processedRequestedAction = useRef<string | undefined>(undefined);
  const [step, setStep] = useState<SetupStep>("action");
  const [hasLoaded, setHasLoaded] = useState(false);
  const [creating, setCreating] = useState(true);
  const [lastApproval, setLastApproval] = useState<{
    owner: string;
    actionName: string;
    agent: string;
    walletId: string;
  } | null>(null);
  const [activationWalletId, setActivationWalletId] = useState<string | null>(null);
  const [skills, setSkills] = useState<PublishedSkillSummary[]>([]);
  const [skillId, setSkillId] = useState("");
  selectedActionRef.current = skillId;
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
    const unfinished = recovered.wallets.find((wallet) => !wallet.grantRevision);
    setActivationWalletId(unfinished?.walletId ?? null);
    setCreating(Boolean(recovered.pending || unfinished || recovered.wallets.length === 0));
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
      setHasLoaded(true);
      if (requestedAction && !list.some((skill) => skill.id === requestedAction)) {
        setSkillId("");
        toast.error("This action is not available to your wallet. Choose one of your own actions.");
      } else if (list.length > 0) {
        setSkillId((current) => requestedAction || current || list[0].id);
      }
      if (list.length === 0)
        toast.message("No published actions yet", {
          description: "Publish a flow in the builder first: a wallet is granted per action.",
        });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load your actions.");
    } finally {
      setBusy(null);
    }
  }, [account, busy, signPersonalMessage, requestedAction]);

  useEffect(() => {
    setSkills([]);
    setSkillId("");
    setAgent("");
    setPairedAgents([]);
    setHasLoaded(false);
    processedRequestedAction.current = undefined;
    setLastApproval(null);
    setActionOptions(null);
    setStep("action");
    setPrepared(null);
    setQuotePreview(null);
  }, [account?.address]);

  async function chooseSelectedAction() {
    if (!account || !skillId || busy) return;
    const selectedId = skillId;
    setBusy("Reading action limits…");
    try {
      const session = await ensureSession(account.address, async (message) => {
        const { signature } = await signPersonalMessage({ message });
        return signature;
      });
      const options = await rillApi.setupOptions(selectedId, session.accessToken);
      if (currentOwner.current !== account.address || selectedActionRef.current !== selectedId)
        return;
      for (const amount of [
        options.budgetMist,
        options.perTxMist,
        options.budgetLimitMist,
        options.perTxLimitMist,
      ]) {
        if (amount !== null && (!/^\d+$/.test(amount) || BigInt(amount) > (1n << 64n) - 1n))
          throw new Error("The action returned invalid spending limits.");
      }
      setActionOptions(options);
      setBudgetSui(baseUnitsToDecimal(options.budgetMist));
      setPerTxSui(baseUnitsToDecimal(options.perTxMist));
      setPrice("");
      setStep("agent");
    } catch (error) {
      if (currentOwner.current === account.address)
        toast.error(error instanceof Error ? error.message : "Could not read action limits.");
    } finally {
      setBusy(null);
    }
  }

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
      setActivationWalletId(onboarded.walletId);
      setCreating(true);
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
    setCreating(true);
    setStep("approve");
    setActivationWalletId(input.walletId);
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
      setActivationWalletId(null);
      setCreating(false);
      setLastApproval({
        owner: account.address,
        actionName: prepared.grant.actionName,
        agent: prepared.grant.agent,
        walletId: prepared.grant.walletId,
      });
      setStep("action");
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
      if (lastApproval?.walletId === granted.walletId) setLastApproval(null);
      if (activationWalletId === granted.walletId) {
        setActivationWalletId(null);
        setStep("action");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Revoking failed.");
    } finally {
      setBusy(null);
    }
  }

  const selfOnboarding = account
    ? isSelfOnboarding(account.address, agent || account.address)
    : false;
  const selectedAction = skills.find((skill) => skill.id === skillId);
  const waitingWallet = wallets.find(
    (wallet) =>
      wallet.walletId === activationWalletId &&
      !wallet.grantRevision &&
      wallet.owner === ownerAddress,
  );
  const committed = Boolean(pending || prepared || waitingWallet);
  const currentStep = committed ? "approve" : step;
  const budgetError = budgetFormError(budgetSui, perTxSui, expiryHours, actionOptions);
  const canVisit = (next: SetupStep) =>
    !busy &&
    canVisitSetupStep(next, skillId, agent, committed, ownerAddress, {
      hasActionOptions: actionOptions !== null,
      budgetIsValid: budgetError === null,
    });
  const beginSetup = () => {
    if (busy || pending || prepared || waitingWallet) return;
    setLastApproval(null);
    setCreating(true);
    setActivationWalletId(null);
    setStep("action");
  };
  const waitingInput = waitingWallet ? grantInputForGranted(waitingWallet) : null;
  const frozenBudget = pending?.input.budgetMist ?? waitingInput?.budgetMist;
  const frozenPerTx = pending?.input.perTxMist ?? waitingInput?.perTxMist;
  const reviewedBudget = frozenBudget
    ? `${baseUnitsToDecimal(frozenBudget)} SUI`
    : committed
      ? "Not saved in this browser"
      : `${budgetSui} SUI`;
  const reviewedPerTx = frozenPerTx
    ? `${baseUnitsToDecimal(frozenPerTx)} SUI`
    : committed
      ? "Not saved in this browser"
      : `${perTxSui} SUI`;

  useEffect(() => {
    if (
      !requestedAction ||
      processedRequestedAction.current === requestedAction ||
      busy ||
      pending ||
      prepared ||
      waitingWallet
    )
      return;
    processedRequestedAction.current = requestedAction;
    setCreating(true);
    if (hasLoaded && !skills.some((skill) => skill.id === requestedAction)) {
      setSkillId("");
      setActionOptions(null);
      setStep("action");
      toast.error("This action is not available to your wallet. Choose one of your own actions.");
      return;
    }
    if (
      hasLoaded &&
      skills.some((skill) => skill.id === requestedAction) &&
      skillId !== requestedAction
    ) {
      setSkillId(requestedAction);
      setActionOptions(null);
      setLastApproval(null);
      setStep("action");
    }
  }, [requestedAction, busy, pending, prepared, waitingWallet, hasLoaded, skills, skillId]);

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">
              Agent workspace
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
              Agents & budgets
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
              Give an agent a budget for one action. You keep your wallet and control when access
              stops.
            </p>
          </div>
          {account && (
            <Button
              variant="outline"
              onClick={beginSetup}
              disabled={Boolean(busy || pending || prepared || waitingWallet)}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add a budget
            </Button>
          )}
        </div>

        {!account ? (
          <section className="mx-auto max-w-lg rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Wallet className="h-6 w-6" />
            </span>
            <h2 className="mt-5 text-xl font-semibold">Start with your wallet</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Connect the wallet that will approve the budget. Your agent uses a separate signer.
            </p>
            <div className="mt-6 flex justify-center">
              <WalletControl />
            </div>
          </section>
        ) : (
          <>
            {lastApproval?.owner === account.address && (
              <section className="mb-8 flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-5">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div>
                  <h2 className="text-sm font-semibold">Agent access approved</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {lastApproval.actionName} is approved for signer{" "}
                    {shortAddress(lastApproval.agent)}. Ask your agent to list its Rill actions and
                    run this action.
                  </p>
                </div>
              </section>
            )}
            {(creating || pending || prepared) && (
              <>
                {!hasLoaded && !committed ? (
                  <section className="max-w-2xl rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
                    <p className="text-xs font-medium uppercase tracking-widest text-primary">
                      New budget
                    </p>
                    <h2 className="mt-3 text-2xl font-semibold">Choose what your agent can do</h2>
                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                      Continue with your connected wallet to see your published actions and
                      connected agents. Signing in does not move funds.
                    </p>
                    <div className="mt-6">
                      <SetupNext onClick={() => void loadSkills()} disabled={Boolean(busy)}>
                        {busy ?? `Continue as ${shortAddress(account.address)}`}
                      </SetupNext>
                    </div>
                    <p className="mt-5 text-xs text-muted-foreground">
                      Need an action first?{" "}
                      <Link to="/builder" className="font-medium text-primary hover:underline">
                        Open the builder
                      </Link>
                    </p>
                  </section>
                ) : (
                  <SetupJourney step={currentStep} canVisit={canVisit} onVisit={setStep}>
                    {currentStep === "action" && (
                      <>
                        <p className="text-sm text-muted-foreground">
                          Choose a flow you published. Each budget gives access to this action only.
                        </p>
                        {skills.length === 0 ? (
                          <div className="rounded-xl bg-muted p-5">
                            <p className="text-sm font-medium">No actions published yet</p>
                            <p className="mt-2 text-sm text-muted-foreground">
                              Create a flow in the builder, then publish it with this wallet.
                            </p>
                            <Link
                              to="/builder"
                              className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-primary"
                            >
                              Build your first action
                              <ArrowRight className="h-4 w-4" />
                            </Link>
                          </div>
                        ) : (
                          <div className="grid gap-3">
                            {skills.map((skill) => (
                              <button
                                key={skill.id}
                                type="button"
                                onClick={() => {
                                  setSkillId(skill.id);
                                  setActionOptions(null);
                                }}
                                disabled={Boolean(busy)}
                                aria-pressed={skillId === skill.id}
                                className={`rounded-xl border p-4 text-left transition ${skillId === skill.id ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:border-primary/40"}`}
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-sm font-semibold">{skill.name}</span>
                                  {skill.version && (
                                    <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                                      v{skill.version}
                                    </span>
                                  )}
                                </div>
                                <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                                  {skill.description}
                                </p>
                                <p className="mt-2 text-[11px] text-muted-foreground">
                                  Published {new Date(skill.createdAt).toLocaleDateString()}
                                </p>
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <button
                            type="button"
                            onClick={() => void loadSkills()}
                            disabled={Boolean(busy)}
                            className="text-xs text-muted-foreground underline"
                          >
                            Refresh actions
                          </button>
                          <SetupNext
                            onClick={() => void chooseSelectedAction()}
                            disabled={Boolean(busy) || !skillId}
                          >
                            {busy ?? "Use this action"}
                          </SetupNext>
                        </div>
                      </>
                    )}

                    {currentStep === "agent" && (
                      <>
                        <p className="text-sm text-muted-foreground">
                          Choose the signer your agent already uses. You only need to connect a new
                          signer once.
                        </p>
                        <SignerPairing
                          key={account.address}
                          owner={account.address}
                          initialAgents={pairedAgents}
                          agent={agent}
                          onSelect={setAgent}
                          onConnected={(record) => {
                            if (record.owner === account.address && record.network === SUI_NETWORK)
                              setPairedAgents((records) => [
                                record,
                                ...records.filter(
                                  (old) =>
                                    old.agent !== record.agent || old.network !== record.network,
                                ),
                              ]);
                          }}
                          session={async () => {
                            const session = await ensureSession(
                              account.address,
                              async (message) => {
                                const { signature } = await signPersonalMessage({ message });
                                return signature;
                              },
                            );
                            return session.accessToken;
                          }}
                        />
                        {agent && selfOnboarding && (
                          <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
                            Use a separate agent signer. Your connected wallet must keep control of
                            approval and revocation.
                          </p>
                        )}
                        <SetupNext onClick={() => setStep("budget")} disabled={!canVisit("budget")}>
                          Use this agent
                        </SetupNext>
                      </>
                    )}

                    {currentStep === "budget" && (
                      <>
                        <p className="text-sm text-muted-foreground">
                          Budget rules were set in Builder. Choose how much to fund within the
                          published limits.
                        </p>
                        <div className="grid gap-5 sm:grid-cols-2">
                          <div>
                            <Label htmlFor="budget">Amount to fund (SUI)</Label>
                            <Input
                              id="budget"
                              value={budgetSui}
                              onChange={(event) => setBudgetSui(event.target.value)}
                              className="mt-2"
                            />
                            <p className="mt-2 text-xs text-muted-foreground">
                              The most this vault can spend in total.
                            </p>
                          </div>
                          <div>
                            <Label htmlFor="pertx">Maximum per run (SUI)</Label>
                            <Input
                              id="pertx"
                              value={perTxSui}
                              onChange={(event) => setPerTxSui(event.target.value)}
                              className="mt-2"
                            />
                            <p className="mt-2 text-xs text-muted-foreground">
                              The cap for one execution of this action.
                            </p>
                          </div>
                          <div>
                            <Label htmlFor="expiry">Access expires after (hours)</Label>
                            <Input
                              id="expiry"
                              value={expiryHours}
                              onChange={(event) => setExpiryHours(event.target.value)}
                              className="mt-2"
                            />
                          </div>
                        </div>
                        {actionOptions?.requiresOrderPrice && (
                          <details className="rounded-xl border border-border p-4 text-sm">
                            <summary className="cursor-pointer text-xs font-medium">
                              Advanced: limit order price
                            </summary>
                            <div className="mt-3 space-y-2">
                              <Label htmlFor="price">Order price (optional)</Label>
                              <Input
                                id="price"
                                value={price}
                                onChange={(event) => setPrice(event.target.value)}
                                placeholder="Use the action's published price"
                              />
                              <p className="text-xs text-muted-foreground">
                                Only for DeepBook orders. Swap and stake actions do not need this.
                              </p>
                            </div>
                          </details>
                        )}
                        {actionOptions && (
                          <details className="rounded-xl border border-border p-4 text-xs text-muted-foreground">
                            <summary className="cursor-pointer font-medium">
                              Published restrictions
                            </summary>
                            <ul className="mt-3 space-y-2">
                              {actionOptions.restrictions.map((rule, index) => (
                                <li key={index} className="break-words">
                                  <strong className="text-foreground">{rule.label}:</strong>{" "}
                                  {rule.value}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                        {budgetError && (
                          <p role="alert" className="text-xs text-amber-800">
                            {budgetError}
                          </p>
                        )}
                        <SetupNext
                          onClick={() => setStep("approve")}
                          disabled={!canVisit("approve") || Boolean(budgetError)}
                        >
                          Review this budget
                        </SetupNext>
                      </>
                    )}

                    {currentStep === "approve" && (
                      <>
                        {prepared ? (
                          <>
                            <p className="text-sm text-muted-foreground">
                              This last signature allows your agent to run the funded action. It
                              does not change the vault's limits.
                            </p>
                            <BudgetSummary>
                              <SummaryItem label="Action">{prepared.grant.actionName}</SummaryItem>
                              <SummaryItem label="Agent signer">
                                {shortAddress(prepared.grant.agent)}
                              </SummaryItem>
                            </BudgetSummary>
                            <div>
                              <p className="mb-2 text-xs font-semibold">
                                Exact permission you are signing
                              </p>
                              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-border bg-muted/50 p-4 font-mono text-xs leading-relaxed">
                                {prepared.message}
                              </pre>
                            </div>
                            <div className="flex flex-wrap gap-3">
                              <Button onClick={signActionGrant} disabled={Boolean(busy)}>
                                {busy ?? "Approve agent access"}
                              </Button>
                              <Button
                                variant="outline"
                                onClick={() => setPrepared(null)}
                                disabled={Boolean(busy)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </>
                        ) : pending ? (
                          <>
                            <BudgetSummary>
                              <SummaryItem label="Budget">{reviewedBudget}</SummaryItem>
                              <SummaryItem label="Maximum per run">{reviewedPerTx}</SummaryItem>
                            </BudgetSummary>
                            <div className="rounded-xl bg-primary/5 p-4">
                              <p className="text-sm font-semibold">
                                {pending.attachment
                                  ? "Confirming your funding"
                                  : "Vault creation submitted. Next, confirm and fund."}
                              </p>
                              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                                {pending.attachment
                                  ? "Check the submitted transaction. We will not submit funding again while it is pending."
                                  : "Your next approval installs the rules and funds the vault together. Until that succeeds, this vault has no spending budget."}
                              </p>
                            </div>
                            <Button
                              onClick={attachAndFund}
                              disabled={Boolean(busy) || account.address !== pending.input.sender}
                            >
                              {busy ??
                                (pending.attachment
                                  ? "Check funding status"
                                  : "Approve rules & funding")}
                            </Button>
                            {!pending.attachment && (
                              <Button
                                variant="outline"
                                onClick={() => {
                                  setPending(null);
                                  setStep("budget");
                                }}
                                disabled={Boolean(busy)}
                              >
                                Start over without funding
                              </Button>
                            )}
                            <details className="text-xs text-muted-foreground">
                              <summary className="cursor-pointer">Transaction details</summary>
                              <p className="mt-2 break-all font-mono">
                                {pending.attachment?.digest ?? pending.digest}
                              </p>
                            </details>
                          </>
                        ) : waitingWallet ? (
                          <>
                            <BudgetSummary>
                              <SummaryItem label="Budget funded">{reviewedBudget}</SummaryItem>
                              <SummaryItem label="Maximum per run">{reviewedPerTx}</SummaryItem>
                            </BudgetSummary>
                            <p className="text-sm text-muted-foreground">
                              Your budget is funded. Review and sign the action permission so your
                              agent can start.
                            </p>
                            <Button
                              onClick={() =>
                                void prepareActionGrant(grantInputForGranted(waitingWallet))
                              }
                              disabled={Boolean(busy)}
                            >
                              {busy ?? "Review agent access"}
                            </Button>
                          </>
                        ) : (
                          <>
                            <BudgetSummary>
                              <SummaryItem label="Action">
                                {selectedAction?.name ?? "Selected action"}
                              </SummaryItem>
                              <SummaryItem label="Agent signer">{shortAddress(agent)}</SummaryItem>
                              <SummaryItem label="Total budget">{budgetSui} SUI</SummaryItem>
                              <SummaryItem label="Maximum per run">{perTxSui} SUI</SummaryItem>
                              <SummaryItem label="Expires after">{expiryHours} hours</SummaryItem>
                              <SummaryItem label="Control">
                                You can revoke and reclaim unused funds
                              </SummaryItem>
                            </BudgetSummary>
                            <p className="text-sm leading-relaxed text-muted-foreground">
                              Your wallet will approve vault creation, then rules and funding, then
                              agent access. Nothing is funded by the preview.
                            </p>
                            {currentPreview && (
                              <div
                                aria-label="Swap funding preview"
                                className={`rounded-xl border p-4 ${currentPreview.outputFloorMet ? "border-primary/30 bg-primary/5" : "border-amber-300 bg-amber-50"}`}
                              >
                                <p className="text-sm font-semibold">
                                  {currentPreview.outputFloorMet
                                    ? "Current quote meets your minimum"
                                    : "Current quote is below your minimum"}
                                </p>
                                <p className="mt-2 text-sm">
                                  Expected output:{" "}
                                  {formatQuotedAmount(
                                    currentPreview.outputCoinType,
                                    currentPreview.quotedOutputBaseUnits,
                                  )}
                                </p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  Minimum:{" "}
                                  {formatQuotedAmount(
                                    currentPreview.outputCoinType,
                                    currentPreview.minimumOutputBaseUnits,
                                  )}
                                  . Input fee:{" "}
                                  {formatQuotedAmount(
                                    currentPreview.inputCoinType,
                                    currentPreview.feeBaseUnits,
                                  )}
                                  .
                                </p>
                                <p className="mt-2 text-xs text-muted-foreground">
                                  {currentPreview.note}
                                </p>
                              </div>
                            )}
                            <div className="flex flex-wrap gap-3">
                              <Button
                                variant="outline"
                                onClick={() => void grant(true)}
                                disabled={
                                  Boolean(busy) ||
                                  !canVisitSetupStep("approve", skillId, agent, false, ownerAddress)
                                }
                              >
                                Check current quote
                              </Button>
                              <Button
                                onClick={() => void grant()}
                                disabled={
                                  Boolean(busy) ||
                                  !canVisitSetupStep("approve", skillId, agent, false, ownerAddress)
                                }
                              >
                                {busy ?? "Approve vault creation"}
                              </Button>
                            </div>
                            <details className="rounded-xl border border-border p-4 text-sm">
                              <summary className="cursor-pointer text-xs font-medium">
                                Advanced: use an existing funded vault
                              </summary>
                              <div className="mt-3 space-y-3">
                                <Label htmlFor="existing-wallet">Vault object ID</Label>
                                <Input
                                  id="existing-wallet"
                                  value={existingWallet}
                                  onChange={(event) => setExistingWallet(event.target.value)}
                                  placeholder="0x…"
                                  className="font-mono text-xs"
                                />
                                <p className="text-xs text-muted-foreground">
                                  Use the selected action and limits above. The server checks the
                                  owner and agent of this vault.
                                </p>
                                <Button
                                  variant="outline"
                                  onClick={() => void prepareActionGrant(grantInputForExisting())}
                                  disabled={Boolean(busy) || !existingWallet}
                                >
                                  Review existing vault access
                                </Button>
                              </div>
                            </details>
                          </>
                        )}
                      </>
                    )}
                  </SetupJourney>
                )}
              </>
            )}

            {wallets.length > 0 && (
              <section className="mt-10 space-y-4">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  <h2 className="text-lg font-semibold">Your saved budgets</h2>
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  {wallets.map((granted) => (
                    <article
                      key={granted.walletId}
                      className="min-w-0 rounded-2xl border border-border bg-card p-5 shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                            <Bot className="h-5 w-5" />
                          </span>
                          <div>
                            <h3 className="text-sm font-semibold">
                              {skills.find((skill) => skill.id === granted.actionId)?.name ??
                                "Agent budget"}
                            </h3>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Vault {shortAddress(granted.walletId)}
                            </p>
                          </div>
                        </div>
                        <span
                          className={`rounded-md px-2 py-1 text-xs ${granted.grantRevision ? "bg-primary/10 text-primary" : "bg-amber-50 text-amber-800"}`}
                        >
                          {granted.grantRevision ? "Access approved" : "Needs activation"}
                        </span>
                      </div>
                      <div className="mt-5">
                        <BudgetSummary>
                          <SummaryItem label="Approved budget">
                            {granted.budgetMist
                              ? `${baseUnitsToDecimal(granted.budgetMist)} SUI`
                              : "See vault details"}
                          </SummaryItem>
                          <SummaryItem label="Maximum per run">
                            {granted.perTxMist
                              ? `${baseUnitsToDecimal(granted.perTxMist)} SUI`
                              : "See vault details"}
                          </SummaryItem>
                        </BudgetSummary>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {!granted.grantRevision && (
                          <Button
                            onClick={() => void prepareActionGrant(grantInputForGranted(granted))}
                            disabled={
                              Boolean(busy || prepared) || account.address !== granted.owner
                            }
                          >
                            Review agent access
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          onClick={() => void revoke(granted)}
                          disabled={Boolean(busy) || account.address !== granted.owner}
                        >
                          Revoke & reclaim
                        </Button>
                      </div>
                      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                        Revoke stops the agent and returns the vault's unused funds to your wallet.
                        The amounts above are approved limits, not a live remaining balance.
                      </p>
                      <details className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
                        <summary className="cursor-pointer">Technical details & exports</summary>
                        <dl className="mt-3 space-y-2 break-all font-mono">
                          <div>
                            <dt>Vault</dt>
                            <dd>{granted.walletId}</dd>
                          </div>
                          <div>
                            <dt>Agent capability</dt>
                            <dd>{granted.agentCapId}</dd>
                          </div>
                          {granted.balanceManagerId && (
                            <div>
                              <dt>Balance manager</dt>
                              <dd>{granted.balanceManagerId}</dd>
                            </div>
                          )}
                          {granted.tradeCapId && (
                            <div>
                              <dt>Trade capability</dt>
                              <dd>{granted.tradeCapId}</dd>
                            </div>
                          )}
                          {granted.depositCapId && (
                            <div>
                              <dt>Deposit capability</dt>
                              <dd>{granted.depositCapId}</dd>
                            </div>
                          )}
                        </dl>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => downloadArtifact(granted, "runSet")}
                          >
                            Download run set
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => downloadArtifact(granted, "buildArguments")}
                          >
                            Download build arguments
                          </Button>
                        </div>
                      </details>
                    </article>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
