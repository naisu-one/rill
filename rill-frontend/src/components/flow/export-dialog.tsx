import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import gsap from "gsap";
import { toast } from "sonner";
import { Check, Loader2, Server, FileText, Sparkles } from "lucide-react";
import type { Edge, Node } from "reactflow";
import { Link } from "@tanstack/react-router";
import { DialogShell } from "@/components/flow/dialog-shell";
import { FlowWarningsBanner } from "@/components/flow/flow-warnings";
import type { ActionNodeData } from "@/components/flow/nodes";
import { buildFlowGraph } from "@/lib/flow-mapper";
import { computePublishGate } from "@/lib/publish-gate";
import { hashFlowGraph } from "@/lib/graph-hash";
import { rillApi, type PublishResult } from "@/lib/rill-api";
import { SUI_NETWORK } from "@/lib/sui-network";
import { useCurrentAccount, useSignPersonalMessage } from "@mysten/dapp-kit";
import { ensureSession } from "@/lib/rill-session";
import { useFlowRequest } from "@/lib/use-flow-request";
import { validateManifest, type CapabilityManifest } from "@/lib/capabilities";
import {
  loadPublishRecordFromStorage,
  savePublishRecordToStorage,
  type StoredPublishRecord,
} from "@/lib/draft-storage";

const easeOut = [0.22, 1, 0.36, 1] as const;

const stagger = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.07, delayChildren: 0.05 },
  },
};

const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: easeOut } },
};

/**
 * Publish is an EXPLICIT action (R16): the dialog always opens to a review
 * step (flow summary, skipped-node/edge warnings, a Publish button) and only
 * POSTs /publish when that button is clicked — never on mount/open. The
 * result is cached per buildFlowGraph-output hash (lib/graph-hash.ts) and
 * persisted to localStorage (lib/draft-storage.ts): reopening with the same
 * hash reuses the cached skill URL with no network call; a changed hash
 * presents the flow as unpublished and labels any previously-shown URL as
 * belonging to an earlier version.
 */

type CopyKind = "mcp" | "config" | "claude" | "codex" | "setup";

/** The signer reads granted actions from this Studio's API, so the setup line names it: an agent
 *  told to run `setup --api <Rill API URL>` had no way to know the URL. */
const signerSetup = `~/.rill/bin/rill-wallet setup --network ${SUI_NETWORK} --as <agent address> --api ${rillApi.baseUrl.replace(/\/api$/, "")}`;

/** One plugin for every published action: install it once and later actions need nothing new. */
const PLUGIN_INSTALL: { agent: string; kind: CopyKind; command: string }[] = [
  {
    agent: "Claude Code",
    kind: "claude",
    command: "/plugin marketplace add rifuki/rill\n/plugin install rill@rill",
  },
  {
    agent: "Codex",
    kind: "codex",
    command: "codex plugin marketplace add rifuki/rill\ncodex plugin add rill@rill",
  },
];
export function ExportDialog({
  nodes,
  edges,
  manifest,
  open,
  onOpenChange,
}: {
  nodes: Node[];
  edges: Edge[];
  manifest: CapabilityManifest;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const actions = nodes.filter((n) => n.type === "action").map((n) => n.data as ActionNodeData);
  const graph = useMemo(() => buildFlowGraph(nodes, edges), [nodes, edges]);
  const account = useCurrentAccount();
  const hash = useMemo(
    () =>
      hashFlowGraph(graph, {
        apiBase: rillApi.baseUrl,
        owner: account?.address,
        manifest,
      }),
    [graph, account?.address, manifest],
  );
  const gate = useMemo(() => {
    const flowGate = computePublishGate(nodes, edges);
    if (!flowGate.publishable) return flowGate;
    const validation = validateManifest(manifest);
    return validation.ok
      ? flowGate
      : {
          publishable: false,
          reason: `Configure wallet capabilities before publishing: ${validation.error}`,
        };
  }, [nodes, edges, manifest]);

  const [storedRecord, setStoredRecord] = useState<StoredPublishRecord | null>(null);
  const [copied, setCopied] = useState<CopyKind | null>(null);
  const mcpBoxRef = useRef<HTMLDivElement>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The hash a publish request was fired FOR, captured at click time — used to
  // avoid a race where the graph changes again while the request is in flight.
  const publishedForHashRef = useRef<string | null>(null);

  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  // The session token captured at click time, so the in-flight request always uses the token that
  // was proved for THIS publish rather than whatever lands in storage later.
  const sessionTokenRef = useRef<string | undefined>(undefined);
  const publishPayloadRef = useRef({ flow: graph, manifest });
  const currentContextRef = useRef({ hash, open });
  currentContextRef.current = { hash, open };
  const [signingIn, setSigningIn] = useState(false);

  const {
    data: freshResult,
    error: publishError,
    loading: publishing,
    run: doPublish,
    reset: resetPublish,
  } = useFlowRequest<PublishResult>((signal) =>
    rillApi.publish(
      publishPayloadRef.current.flow,
      signal,
      sessionTokenRef.current,
      publishPayloadRef.current.manifest,
    ),
  );

  // Re-read localStorage every time the dialog opens — this component is now
  // mounted persistently (Radix controls visibility), not remounted per open,
  // so a publish result saved on a previous open (or a previous visit) needs
  // an explicit re-read rather than a mount-once initializer. Also clears any
  // stale error/result left over from a previous open (mirrors the old
  // fresh-mount-per-open behavior).
  useEffect(() => {
    if (!open) return;
    setStoredRecord(loadPublishRecordFromStorage());
    resetPublish();
  }, [open, resetPublish]);

  // Persists a fresh result the instant it lands. This never fires the
  // request itself — that only happens from handlePublish's explicit click.
  useEffect(() => {
    if (!freshResult || !publishedForHashRef.current) return;
    const record: StoredPublishRecord = { hash: publishedForHashRef.current, result: freshResult };
    savePublishRecordToStorage(record);
    setStoredRecord(record);
  }, [freshResult]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const published = storedRecord && storedRecord.hash === hash ? storedRecord.result : null;
  const staleRecord = storedRecord && storedRecord.hash !== hash ? storedRecord : null;
  const justPublished =
    published !== null && freshResult !== null && publishedForHashRef.current === hash;

  const handlePublish = async () => {
    if (!gate.publishable) {
      toast.error(gate.reason ?? "This flow can't be compiled & exported yet.");
      return;
    }

    if (signingIn || publishing) return;
    const snapshot = { flow: structuredClone(graph), manifest: structuredClone(manifest), hash };
    // A connected wallet must prove ownership before publishing its action.
    sessionTokenRef.current = undefined;
    if (account) {
      setSigningIn(true);
      try {
        const session = await ensureSession(account.address, async (message) => {
          const { signature } = await signPersonalMessage({ message });
          return signature;
        });
        sessionTokenRef.current = session.accessToken;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Wallet sign-in failed.");
        return;
      } finally {
        setSigningIn(false);
      }
    }

    if (!currentContextRef.current.open || currentContextRef.current.hash !== snapshot.hash) {
      toast.message("The flow or wallet changed. Review it before publishing again.");
      return;
    }
    publishPayloadRef.current = snapshot;
    publishedForHashRef.current = snapshot.hash;
    doPublish();
  };

  useEffect(() => {
    if (!published || !mcpBoxRef.current) return;
    gsap.fromTo(
      mcpBoxRef.current,
      { scale: 0.96, boxShadow: "0 0 0 rgba(0,0,0,0)" },
      {
        scale: 1,
        boxShadow: "0 0 0 3px oklch(0.72 0.12 165 / 0.35)",
        duration: 0.55,
        ease: "back.out(1.6)",
      },
    );
    gsap.to(mcpBoxRef.current, {
      boxShadow: "0 0 0 0px oklch(0.72 0.12 165 / 0)",
      delay: 0.9,
      duration: 0.6,
      ease: "power2.out",
    });
  }, [published]);

  /**
   * The URL to hand the user. An owned skill gets the single owner-scoped connector, which serves
   * every action this address publishes and needs no reconnection when another is added later; an
   * ownerless one falls back to its per-skill URL, which is all it can be reached at.
   */
  const connectUrl = published ? (published.ownerMcpUrl ?? published.mcpUrl) : "";

  const claudeConfig = useMemo(() => {
    if (!published) return "";
    return JSON.stringify(
      {
        mcpServers: {
          "rill-actions": {
            url: published.ownerMcpUrl ?? published.mcpUrl,
          },
        },
      },
      null,
      2,
    );
  }, [published]);

  const copy = async (text: string, kind: CopyKind) => {
    await navigator.clipboard.writeText(text);
    setCopied(kind);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => {
      setCopied(null);
      copyTimeoutRef.current = null;
    }, 2000);
  };

  const flowSummary = actions.map((a) => `${a.protocol} · ${a.action}`).join(" → ");

  const title = publishing
    ? "Publishing flow…"
    : published
      ? "Published. Now grant it"
      : "Review & publish";
  const description = publishing
    ? "Publishing action metadata and registering the bounded Rill tools."
    : published
      ? "Your agent runs this action through the Rill plugin, from a wallet you fund and a grant you sign."
      : "Nothing is sent until you click Publish below.";

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      eyebrow="Publish"
      title={title}
      description={description}
    >
      {(graph.skipped.length > 0 || graph.skippedEdges.length > 0) && (
        <div className="px-5 pt-4">
          <FlowWarningsBanner skippedNodes={graph.skipped} skippedEdges={graph.skippedEdges} />
        </div>
      )}

      <div className="p-5 space-y-4 min-h-[180px]">
        {publishing && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-10 gap-4"
          >
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
            >
              <Loader2 className="h-8 w-8 text-primary" />
            </motion.div>
            <div className="flex gap-1.5">
              {["Compose", "Simulate", "Publish"].map((step, i) => (
                <motion.span
                  key={step}
                  className="text-[11px] rounded-full border border-border px-2.5 py-1 text-muted-foreground"
                  initial={{ opacity: 0.4 }}
                  animate={{ opacity: [0.4, 1, 0.4] }}
                  transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.35 }}
                >
                  {step}
                </motion.span>
              ))}
            </div>
          </motion.div>
        )}

        {!publishing && !published && (
          <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-4">
            <motion.div variants={fadeUp}>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                This flow
              </div>
              <p className="mt-1 text-sm font-medium text-foreground">
                {flowSummary || "No supported actions on this canvas yet."}
              </p>
            </motion.div>

            <motion.div
              variants={fadeUp}
              className="space-y-2.5 rounded-xl border border-border/60 bg-muted/30 p-3.5"
            >
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                <Sparkles className="h-3 w-3" /> Publishing creates
              </div>
              <div className="flex gap-2.5">
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-mint/50 text-mint-foreground">
                  <Server className="h-3.5 w-3.5" />
                </span>
                <div className="text-[11px] leading-relaxed">
                  <div className="font-medium text-foreground">An action for your agent</div>
                  <p className="text-muted-foreground">
                    It runs once you grant it from a wallet you fund, and only within that wallet's
                    limits.
                  </p>
                </div>
              </div>
              <div className="flex gap-2.5">
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky/40 text-sky-foreground">
                  <FileText className="h-3.5 w-3.5" />
                </span>
                <div className="text-[11px] leading-relaxed">
                  <div className="font-medium text-foreground">SKILL.md + agent instructions</div>
                  <p className="text-muted-foreground">
                    Readable docs for the action, its inputs and its limits.
                  </p>
                </div>
              </div>
            </motion.div>

            {staleRecord && (
              <motion.div
                variants={fadeUp}
                className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-300"
              >
                <p className="font-medium">Unpublished — flow changed</p>
                <p className="mt-1">
                  This flow was edited since it was last published. The previous MCP URL belongs to
                  an earlier version:{" "}
                  <code className="break-all text-[10px] opacity-80">
                    {staleRecord.result.mcpUrl}
                  </code>
                </p>
              </motion.div>
            )}

            {publishError && (
              <motion.p
                variants={fadeUp}
                className="text-sm text-destructive rounded-lg border border-destructive/30 bg-destructive/5 p-3"
              >
                {publishError}
              </motion.p>
            )}

            {!gate.publishable && gate.reason && (
              <motion.p
                variants={fadeUp}
                id="export-gate-reason"
                className="text-xs text-amber-800 dark:text-amber-300 rounded-lg border border-amber-400/40 bg-amber-400/10 p-3"
              >
                {gate.reason}
              </motion.p>
            )}

            <motion.button
              variants={fadeUp}
              whileHover={gate.publishable ? { scale: 1.02 } : undefined}
              whileTap={gate.publishable ? { scale: 0.98 } : undefined}
              onClick={handlePublish}
              aria-disabled={!gate.publishable}
              aria-describedby={!gate.publishable ? "export-gate-reason" : undefined}
              className={`w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition-colors ${
                gate.publishable
                  ? "cursor-pointer bg-foreground text-background hover:opacity-90"
                  : "cursor-not-allowed bg-foreground/40 text-background/70"
              }`}
            >
              {signingIn ? "Waiting for your wallet…" : "Publish"}
            </motion.button>
          </motion.div>
        )}

        {published && !publishing && (
          <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-4">
            <motion.div variants={fadeUp} className="flex items-center gap-2 text-mint-foreground">
              <motion.span
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 500, damping: 18, delay: 0.1 }}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-mint/30"
              >
                <Check className="h-3.5 w-3.5" />
              </motion.span>
              <span className="text-sm font-medium">
                {justPublished ? "Published successfully" : "Already published"}
              </span>
            </motion.div>

            <motion.div
              variants={fadeUp}
              className="space-y-3 rounded-lg border border-border/60 bg-muted/30 px-4 py-3 text-sm"
            >
              <p className="font-medium">Next</p>
              <ol className="list-decimal list-inside space-y-3 text-xs text-muted-foreground">
                <li>
                  Install the Rill plugin in your agent, once. It runs the signer on your machine;
                  the agent's key never leaves it.
                  {PLUGIN_INSTALL.map(({ agent, kind, command }) => (
                    <div key={kind} className="mt-1.5 flex items-start gap-2">
                      <span className="w-20 shrink-0 pt-2 text-[11px]">{agent}</span>
                      <code className="flex-1 whitespace-pre-wrap break-all rounded-lg border border-border bg-foreground/5 px-3 py-2 text-[11px] text-foreground">
                        {command}
                      </code>
                      <button
                        onClick={() => copy(command, kind)}
                        className="shrink-0 cursor-pointer pt-2 text-[11px] text-primary hover:underline"
                      >
                        {copied === kind ? "Copied" : "Copy"}
                      </button>
                    </div>
                  ))}
                  <p className="mt-2">
                    Then point its signer at this Studio, with your agent's address. Mainnet signing
                    stays off until you add <code>--allow-mainnet</code> yourself.
                  </p>
                  <div className="mt-1.5 flex items-start gap-2">
                    <code className="flex-1 whitespace-pre-wrap break-all rounded-lg border border-border bg-foreground/5 px-3 py-2 text-[11px] text-foreground">
                      {signerSetup}
                    </code>
                    <button
                      onClick={() => copy(signerSetup, "setup")}
                      className="shrink-0 cursor-pointer pt-2 text-[11px] text-primary hover:underline"
                    >
                      {copied === "setup" ? "Copied" : "Copy"}
                    </button>
                  </div>
                </li>
                <li>
                  Fund a wallet for your agent and sign a grant for this action.{" "}
                  <Link to="/agent-wallet" className="text-primary hover:underline">
                    Open Agent wallet
                  </Link>
                </li>
                <li>
                  Ask your agent to list its Rill actions and run this one. It can only do what the
                  grant and the wallet allow.
                </li>
              </ol>
            </motion.div>

            <motion.details variants={fadeUp} className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Advanced: the keyless builder over MCP</summary>
              <p className="mt-2">
                Builds unsigned transactions for an agent that signs elsewhere. It holds no keys and
                cannot spend; the plugin above is what runs granted actions.
              </p>
              <div className="mt-3">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  MCP server URL
                </label>
                <p className="mt-1 text-xs text-muted-foreground">
                  {published.ownerMcpUrl
                    ? "Your connector. It serves every action you publish: add it once and anything you publish later shows up without reconnecting."
                    : "This action's own link. Sign in with your wallet before publishing to get one connector URL for everything instead."}
                </p>
                <div ref={mcpBoxRef} className="mt-1.5 flex gap-2 rounded-xl">
                  <code className="flex-1 rounded-lg border border-border bg-foreground/5 px-3 py-2.5 text-xs break-all">
                    {connectUrl}
                  </code>
                  <motion.button
                    whileHover={{ scale: 1.04 }}
                    whileTap={{ scale: 0.96 }}
                    onClick={() => copy(connectUrl, "mcp")}
                    className="shrink-0 cursor-pointer rounded-full bg-foreground text-background px-4 py-2 text-sm font-medium"
                  >
                    <AnimatePresence mode="wait">
                      {copied === "mcp" ? (
                        <motion.span
                          key="copied"
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -6 }}
                          className="inline-flex items-center gap-1"
                        >
                          <Check className="h-3.5 w-3.5" /> Copied
                        </motion.span>
                      ) : (
                        <motion.span
                          key="copy"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                        >
                          Copy URL
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </motion.button>
                </div>
              </div>

              <div className="mt-3 rounded-lg border border-border/60 bg-muted/30 px-4 py-3 text-sm space-y-2">
                <p className="font-medium">How to use</p>
                <ol className="list-decimal list-inside text-muted-foreground space-y-1 text-xs">
                  <li>
                    Copy the MCP URL above and add it as{" "}
                    <code className="text-foreground">rill-actions</code>
                  </li>
                  <li>
                    Call <code className="text-foreground">list_actions</code>, then{" "}
                    <code className="text-foreground">describe_action</code>
                  </li>
                  <li>
                    Call <code className="text-foreground">build_action</code> with public wallet
                    IDs and runtime params → get an unsigned ExecutionEnvelope
                  </li>
                </ol>
              </div>

              <div className="mt-3">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Claude Code config (optional)
                </label>
                <pre className="mt-1.5 rounded-lg border border-border bg-foreground/5 p-3 text-[11px] font-mono overflow-auto max-h-36">
                  {claudeConfig}
                </pre>
                <motion.button
                  whileHover={{ x: 2 }}
                  onClick={() => copy(claudeConfig, "config")}
                  className="mt-2 cursor-pointer text-xs text-primary hover:underline"
                >
                  {copied === "config" ? "Copied!" : "Copy config JSON"}
                </motion.button>
              </div>
            </motion.details>

            {published.warnings.length > 0 && (
              <motion.p variants={fadeUp} className="text-xs text-amber-700 dark:text-amber-400">
                Warnings: {published.warnings.join(" · ")}
              </motion.p>
            )}

            {published.skillUrl && (
              <motion.p
                variants={fadeUp}
                className="text-xs text-muted-foreground border-t border-border pt-3"
              >
                Need human-readable docs?{" "}
                <a
                  href={published.skillUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  Open SKILL.md
                </a>{" "}
                (includes the same MCP URL + bounded remote/local handoff)
              </motion.p>
            )}

            <motion.p variants={fadeUp} className="text-[10px] text-muted-foreground">
              Flow: {flowSummary}
            </motion.p>
          </motion.div>
        )}
      </div>
    </DialogShell>
  );
}
