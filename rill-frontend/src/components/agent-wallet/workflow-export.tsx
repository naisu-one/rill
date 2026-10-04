import { useState } from "react";
import { ArrowDown, ArrowUp, Copy, Download, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Granted } from "@/lib/grant-storage";
import { buildAgentWorkflow } from "@/lib/agent-workflow";
import type { PublishedSkillSummary } from "@/lib/rill-api";
import { shortAddress } from "@/lib/setup-navigation";
import { SUI_NETWORK } from "@/lib/sui-network";

export function WorkflowExport({
  wallets,
  owner,
  skills,
}: {
  wallets: Granted[];
  owner: string;
  skills: PublishedSkillSummary[];
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const grants = selected.flatMap((id) => wallets.find((grant) => grant.walletId === id) ?? []);
  const label = (grant: Granted) =>
    skills.find((skill) => skill.id === grant.actionId)?.name ?? shortAddress(grant.walletId);
  function change(next: string[]) {
    setSelected(next);
    setRunId(null);
    setError(null);
  }
  function move(index: number, direction: number) {
    const next = [...selected];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    change(next);
  }
  function prepare() {
    if (grants.length !== selected.length)
      throw new Error("A selected budget was removed. Select the remaining steps again.");
    // Repeated downloads retain the same execution ID. Editing steps creates a different run.
    const id = runId ?? crypto.randomUUID();
    const workflow = buildAgentWorkflow(grants, owner, SUI_NETWORK, id);
    setRunId(id);
    return workflow;
  }
  async function copy() {
    try {
      const workflow = prepare();
      await navigator.clipboard.writeText(JSON.stringify(workflow, null, 2));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not copy this workflow.");
    }
  }
  function download() {
    try {
      const workflow = prepare();
      const id = workflow.runId;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(workflow, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `rill-workflow-${id}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not export this workflow.");
    }
  }
  return (
    <section className="mt-10 border-t border-border pt-8" aria-label="Agent workflow">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold">Run actions in sequence</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Choose approved budgets, then set their order. Your agent runs each action with its own
            budget and stops if a step fails. Earlier transactions stay final. Swap proceeds are not
            automatically used for staking or orders.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void copy()} disabled={selected.length === 0}>
            <Copy className="mr-2 h-4 w-4" /> Copy workflow
          </Button>
          <Button variant="outline" onClick={download} disabled={selected.length === 0}>
            <Download className="mr-2 h-4 w-4" /> Download workflow
          </Button>
        </div>
      </div>
      {wallets.length === 0 ? (
        <p className="mt-5 text-sm text-muted-foreground">
          Approve budgets above to add actions here.
        </p>
      ) : (
        <div className="mt-5 flex flex-wrap gap-2">
          {wallets
            .filter((grant) => !selected.includes(grant.walletId))
            .map((grant) => (
              <Button
                key={grant.walletId}
                size="sm"
                variant="outline"
                disabled={!grant.grantRevision || selected.length >= 10}
                onClick={() => change([...selected, grant.walletId])}
              >
                <Plus className="mr-1 h-4 w-4" /> {label(grant)}
              </Button>
            ))}
        </div>
      )}
      <ol className="mt-4 divide-y divide-border">
        {selected.map((id, index) => {
          const grant = wallets.find((grant) => grant.walletId === id);
          return (
            <li key={id} className="flex items-center gap-3 py-3">
              <span className="w-6 text-sm text-muted-foreground">{index + 1}.</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {grant ? label(grant) : "Budget removed"}
                </p>
                <p className="text-xs text-muted-foreground">{shortAddress(id)}</p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Move step ${index + 1} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Move step ${index + 1} down`}
                disabled={index === selected.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Remove step ${index + 1}`}
                onClick={() => change(selected.filter((value) => value !== id))}
              >
                <X className="h-4 w-4" />
              </Button>
            </li>
          );
        })}
      </ol>
      {selected.length > 0 && (
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Give this file to your agent and call <code>rill_run_workflow</code> with its contents.
          Use the same run ID to check a result; creating a new run can spend again. Requires a
          signer build that includes this tool.
        </p>
      )}
      {runId && (
        <p role="status" className="mt-3 break-all text-xs text-muted-foreground">
          Workflow prepared. Run ID: <code>{runId}</code>
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
