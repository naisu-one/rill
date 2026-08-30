import { createFileRoute } from "@tanstack/react-router";
import { ConnectButton, useCurrentAccount, useSignPersonalMessage } from "@mysten/dapp-kit";
import { useEffect, useState } from "react";
import { SiteHeader } from "@/components/site-chrome";
import { Button } from "@/components/ui/button";
import { rillApi, type ConsentPrompt } from "@/lib/rill-api";

/**
 * Sign-in page for the OAuth flow an agent starts.
 *
 * The agent sends the user's browser here (via the backend's `/oauth/authorize`, which parks the
 * request and redirects with `?request=<id>`). All this page does is: show who is asking, have the
 * user's wallet sign the exact message the backend generated, post that signature back, and follow
 * the redirect the backend returns.
 *
 * Two rules this page must not break:
 *
 * 1. **The message is passed through byte-for-byte.** It is never rebuilt, reformatted, or
 *    re-wrapped here. Whatever the backend generated is what the wallet displays and signs; if this
 *    page ever composed its own version, a user could sign text they were never shown.
 * 2. **This is a login, not an approval.** No transaction is built or signed here, and the copy says
 *    so plainly — the spending bound lives in the on-chain agent wallet, not in this signature.
 */
export const Route = createFileRoute("/authorize")({
  head: () => ({
    meta: [
      { title: "Authorize — Rill" },
      { name: "description", content: "Connect your Sui wallet to authorize an AI agent to build Rill transactions." },
      // Never let a sign-in URL, which carries a one-time request id, be indexed or previewed.
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: AuthorizePage,
});

type Status =
  | { kind: "loading" }
  | { kind: "ready"; prompt: ConsentPrompt }
  | { kind: "signing"; prompt: ConsentPrompt }
  | { kind: "redirecting"; prompt: ConsentPrompt; address: string }
  | { kind: "error"; message: string };

function requestIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("request");
}

function AuthorizePage() {
  const account = useCurrentAccount();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [requestId] = useState<string | null>(() => requestIdFromLocation());

  useEffect(() => {
    if (!requestId) {
      setStatus({
        kind: "error",
        message: "This page opens from your AI agent. Add the Rill connector there and it will send you back here.",
      });
      return;
    }
    const controller = new AbortController();
    rillApi
      .consentPrompt(requestId, controller.signal)
      .then((prompt) => setStatus({ kind: "ready", prompt }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setStatus({ kind: "error", message: err instanceof Error ? err.message : "Could not load this sign-in request." });
      });
    return () => controller.abort();
  }, [requestId]);

  async function approve() {
    if (status.kind !== "ready" || !requestId) return;
    const { prompt } = status;
    setStatus({ kind: "signing", prompt });
    try {
      // The backend's bytes, untouched. See rule 1 in this file's header.
      const { signature } = await signPersonalMessage({
        message: new TextEncoder().encode(prompt.message),
      });
      const { redirectTo, address } = await rillApi.completeConsent(requestId, signature);
      setStatus({ kind: "redirecting", prompt, address });
      window.location.href = redirectTo;
    } catch (err: unknown) {
      // A rejected wallet prompt is the common case and is not an error state to dead-end on — the
      // backend keeps the request alive on a failed signature, so returning to `ready` lets the user
      // simply try again instead of restarting the whole flow from their agent.
      setStatus({ kind: "ready", prompt });
      const message = err instanceof Error ? err.message : "Signing failed.";
      if (!/reject|denied|cancel/i.test(message)) console.error("[authorize]", message);
    }
  }

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <section className="mx-auto flex max-w-lg flex-col px-6 pt-16 pb-24">
        {status.kind === "loading" && (
          <p className="text-sm text-muted-foreground">Loading this sign-in request…</p>
        )}

        {status.kind === "error" && (
          <div>
            <h1 className="font-display text-3xl tracking-tight">Sign-in unavailable</h1>
            <p className="mt-3 text-sm text-muted-foreground">{status.message}</p>
          </div>
        )}

        {(status.kind === "ready" || status.kind === "signing" || status.kind === "redirecting") && (
          <div>
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Authorize</div>
            <h1 className="mt-2 font-display text-4xl tracking-tight">
              Connect {status.prompt.clientName} to Rill
            </h1>
            <p className="mt-3 text-sm text-muted-foreground">
              Signing in proves you control the wallet. It moves no funds and approves no
              transaction — every spend stays bounded by your on-chain agent wallet, and Rill never
              holds your private key.
            </p>

            <dl className="mt-8 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Agent</dt>
              <dd>{status.prompt.clientName}</dd>
              <dt className="text-muted-foreground">Network</dt>
              <dd className="capitalize">{status.prompt.network}</dd>
              <dt className="text-muted-foreground">Access</dt>
              <dd>Build and simulate your published Rill actions</dd>
            </dl>

            <details className="mt-6 rounded-md border border-border">
              <summary className="cursor-pointer px-4 py-3 text-sm">
                Read the exact message you will sign
              </summary>
              <pre className="overflow-x-auto border-t border-border px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                {status.prompt.message}
              </pre>
            </details>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              {!account ? <ConnectButton /> : (
                <Button onClick={approve} disabled={status.kind !== "ready"}>
                  {status.kind === "signing" && "Waiting for your wallet…"}
                  {status.kind === "redirecting" && "Returning you to your agent…"}
                  {status.kind === "ready" && "Sign in with this wallet"}
                </Button>
              )}
              {account && (
                <span className="font-mono text-xs text-muted-foreground">
                  {account.address.slice(0, 6)}…{account.address.slice(-4)}
                </span>
              )}
            </div>

            {!account && (
              <p className="mt-3 text-xs text-muted-foreground">
                Connect the wallet that owns — or will own — your agent wallet. That address is your
                Rill identity.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
