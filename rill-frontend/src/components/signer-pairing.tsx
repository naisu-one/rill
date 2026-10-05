import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { rillApi, type PairedAgent, type PreparedPairing } from "@/lib/rill-api";
import {
  defaultPairedAgent,
  pairedForOwner,
  pairingCommand,
  samePairingContext,
} from "@/lib/signer-pairing";
import { shortAddress } from "@/lib/setup-navigation";
import { SUI_NETWORK } from "@/lib/sui-network";

type Props = {
  owner: string;
  initialAgents: PairedAgent[];
  agent: string;
  session: () => Promise<string>;
  onSelect: (agent: string) => void;
  onConnected?: (record: PairedAgent) => void;
  connectOnly?: boolean;
};
export function SignerPairing({
  owner,
  initialAgents,
  agent,
  session,
  onSelect,
  onConnected,
  connectOnly = false,
}: Props) {
  const [agents, setAgents] = useState<PairedAgent[]>(initialAgents);
  const [pending, setPending] = useState<(PreparedPairing & { agent: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setAgents(initialAgents), [initialAgents]);
  const context = useRef({ owner, agent: agent.trim(), requestId: pending?.requestId });
  context.current = { owner, agent: agent.trim(), requestId: pending?.requestId };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const verified = pairedForOwner(agents, owner, SUI_NETWORK);
  const selectedVerified = verified.some((record) => record.agent === agent.trim());
  async function perform(task: (current: () => boolean) => Promise<void>) {
    if (busy) return;
    const started = { ...context.current };
    const current = () => mounted.current && samePairingContext(started, context.current);
    setBusy(true);
    try {
      await task(current);
    } catch (error) {
      if (current()) toast.error(error instanceof Error ? error.message : "Pairing failed.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="space-y-4">
      {!connectOnly && (
        <>
          <p className="text-sm font-medium">Available agents</p>
          <p className="text-xs text-muted-foreground">
            The private key stays in your agent's runtime. Choose its connected signer below.
          </p>
          {agent && (
            <p className="text-xs">
              {selectedVerified
                ? "Verified for your wallet and network."
                : "This signer has not been paired yet. Prove it before approving a budget."}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void perform(async (current) => {
                  const token = await session();
                  if (!current()) return;
                  const records = await rillApi.pairedAgents(token);
                  if (current()) {
                    setAgents(records);
                    const selected = defaultPairedAgent(records, owner, SUI_NETWORK, agent);
                    if (selected) onSelect(selected);
                    if (pairedForOwner(records, owner, SUI_NETWORK).length === 0) {
                      toast.message("No connected agent yet. Open Connect a new agent below.");
                    }
                  }
                })
              }
            >
              {busy ? "Loading…" : "Refresh agents"}
            </Button>
          </div>
          {verified.length > 0 && (
            <select
              aria-label="Paired agent signer"
              className="w-full rounded-md border border-input bg-background p-2 text-xs"
              value={selectedVerified ? agent : ""}
              onChange={(event) => onSelect(event.target.value)}
            >
              <option value="">Choose a connected agent</option>
              {verified.map((record) => (
                <option key={record.agent} value={record.agent}>
                  Connected signer · {shortAddress(record.agent)}
                </option>
              ))}
            </select>
          )}
        </>
      )}
      <details
        open={connectOnly || undefined}
        className={connectOnly ? "" : "rounded-md border border-border p-3"}
      >
        <summary className={connectOnly ? "hidden" : "cursor-pointer text-xs font-medium"}>
          Connect a new agent
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            Ask your agent for its Rill signer address, or run <code>rill-wallet address</code> in
            its runtime. Only this first connection needs the public address. The private key stays
            with the agent.
          </p>
          <Label htmlFor="agent">Agent signer address</Label>
          <Input
            id="agent"
            value={agent}
            onChange={(event) => onSelect(event.target.value)}
            placeholder="0x… public address from your agent"
            className="font-mono text-xs"
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(agent.trim()) || agent.trim() === owner}
            onClick={() =>
              void perform(async (current) => {
                const address = agent.trim();
                const token = await session();
                if (!current()) return;
                const request = await rillApi.preparePairing(address, SUI_NETWORK, token);
                if (current()) setPending({ ...request, agent: address });
              })
            }
          >
            {busy && !pending ? "Preparing pairing…" : "Prepare pairing"}
          </Button>
        </div>
      </details>
      {pending && (
        <div className="space-y-2">
          <p className="text-xs">
            Run this command in your agent runtime before{" "}
            {new Date(pending.expiresAt).toLocaleString()}:
          </p>
          <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
            {pairingCommand(pending.requestId, rillApi.origin, pending.agent)}
          </pre>
          <p className="break-all text-xs text-muted-foreground">Request: {pending.requestId}</p>
          <Button
            type="button"
            disabled={busy || pending.agent !== agent.trim()}
            onClick={() =>
              void perform(async (current) => {
                const challenge = await rillApi.pairingChallenge(pending.requestId);
                if (!current()) return;
                if (
                  challenge.owner !== owner ||
                  challenge.agent !== pending.agent ||
                  challenge.status !== "proved"
                )
                  throw new Error(
                    "The original owner must confirm after the local signer proves this request.",
                  );
                const token = await session();
                if (!current()) return;
                const paired = await rillApi.confirmPairing(pending.requestId, token);
                if (!current()) return;
                setAgents((current) => [
                  ...current.filter(
                    (record) => record.agent !== paired.agent || record.network !== paired.network,
                  ),
                  paired,
                ]);
                onConnected?.(paired);
                onSelect(paired.agent);
                setPending(null);
                toast.success("Agent signer paired. Configure its vault permission next.");
              })
            }
          >
            {busy ? "Checking proof…" : "Check proof and confirm pairing"}
          </Button>
        </div>
      )}
    </section>
  );
}
