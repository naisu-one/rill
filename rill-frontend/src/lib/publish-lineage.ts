import type { PublishResult } from "./rill-api";

/** An edited draft can extend only a publication from this owner and deployment. */
export function parentPublication(
  previous: PublishResult | null | undefined,
  owner: string | undefined,
  apiBase: string,
): string | undefined {
  if (!previous?.owner || !owner || previous.owner.toLowerCase() !== owner.toLowerCase()) {
    return undefined;
  }
  if (!previous.mcpUrl.startsWith(`${apiBase.replace(/\/$/, "")}/mcp/`)) return undefined;
  return previous.skillId;
}
