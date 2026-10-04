import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { rillApi, type PairedAgent, type PreparedPairing } from "@/lib/rill-api";
import { pairedForOwner, pairingCommand, samePairingContext } from "@/lib/signer-pairing";
import { SUI_NETWORK } from "@/lib/sui-network";

type Props = {
  owner: string;
  agent: string;
  session: () => Promise<string>;
  onSelect: (agent: string) => void;
};
export function SignerPairing({ owner, agent, session, onSelect }: Props) {
  const [agents, setAgents] = useState<PairedAgent[]>([]);
  const [pending, setPending] = useState<(PreparedPairing & { agent: string }) | null>(null);
  const [busy, setBusy] = useState(false);
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
    <section className="mt-3 space-y-3 rounded-md border border-border p-3">
      <p className="text-sm font-medium">Connect your local agent signer</p>
      <p className="text-xs text-muted-foreground">
        Your browser wallet controls the vault. The agent proves its own signer locally. Pairing
        grants no spending permission.
      </p>
      {agent && (
        <p className="text-xs">
          {selectedVerified
            ? "Signer ownership verified for this owner and network."
            : "Unverified address. You can pair it before creating the vault."}
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
              if (current()) setAgents(records);
            })
          }
        >
          Load paired agents
        </Button>
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
          Prepare pairing
        </Button>
      </div>
      {verified.length > 0 && (
        <select
          aria-label="Paired agent signer"
          className="w-full rounded-md border border-input bg-background p-2 text-xs"
          value={selectedVerified ? agent : ""}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">Select a verified signer</option>
          {verified.map((record) => (
            <option key={record.agent} value={record.agent}>
              {record.agent}
            </option>
          ))}
        </select>
      )}
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
                onSelect(paired.agent);
                setPending(null);
                toast.success("Agent signer paired. Configure its vault permission next.");
              })
            }
          >
            Check proof and confirm pairing
          </Button>
        </div>
      )}
    </section>
  );
}
