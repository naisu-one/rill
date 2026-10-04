import type { PairedAgent } from "./rill-api";
import type { SuiNetwork } from "./sui-network";

export type PairingContext = { owner: string; agent: string; requestId?: string };
export function samePairingContext(started: PairingContext, current: PairingContext): boolean {
  return (
    started.owner === current.owner &&
    started.agent === current.agent &&
    started.requestId === current.requestId
  );
}

export function pairingCommand(requestId: string, apiOrigin: string, agent: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(requestId) || !/^0x[0-9a-fA-F]{64}$/.test(agent)) {
    throw new Error("Pairing requires a valid request ID and full agent address.");
  }
  const url = new URL(apiOrigin);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Pairing API URL must contain no credentials, query or fragment.");
  }
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  return `rill-wallet pair --request ${quote(requestId)} --api ${quote(apiOrigin)} --as ${quote(agent)}`;
}

export function pairedForOwner(
  agents: PairedAgent[],
  owner: string,
  network: SuiNetwork,
): PairedAgent[] {
  return agents.filter(
    (agent) => agent.owner === owner && agent.network === network && agent.agent !== owner,
  );
}
