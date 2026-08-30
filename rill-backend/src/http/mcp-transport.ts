import { handleMcpJsonRpc, type McpScope } from '../features/mcp/mcp.service';

/**
 * The Streamable-HTTP JSON-RPC envelope shared by both MCP endpoints — the public per-skill
 * `/api/mcp/:skillId` and the OAuth-protected owner-scoped `/mcp`.
 *
 * Extracted rather than duplicated because the two endpoints must be indistinguishable at the
 * transport layer: an MCP client that works against one and not the other, over something as
 * incidental as batch handling or the 202-for-notifications convention, is a bug that only shows up
 * in whichever host the developer didn't test. Scope is the ONLY difference between them.
 */

export type McpHttpResult =
  | { status: 200; body: unknown }
  | { status: 202 }
  | { status: 400; body: unknown };

/** Parse-error body, per JSON-RPC 2.0 §5.1. Always answered with HTTP 400. */
export const MCP_PARSE_ERROR_BODY = {
  jsonrpc: '2.0',
  id: null,
  error: { code: -32700, message: 'Parse error' },
} as const;

export async function dispatchMcpPayload(scope: string | McpScope, payload: unknown): Promise<McpHttpResult> {
  // JSON-RPC batch (R14): an array of request objects answered with an array of the corresponding
  // responses, omitting entries that were notifications (which get no response at all).
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return {
        status: 400,
        body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: batch must not be empty.' } },
      };
    }
    const responses = await Promise.all(
      payload.map((entry) => handleMcpJsonRpc(scope, entry as Record<string, unknown>)),
    );
    const nonNull = responses.filter((response): response is Record<string, unknown> => response !== null);
    // A batch made entirely of notifications gets no body — same 202 convention as a single one.
    if (nonNull.length === 0) return { status: 202 };
    return { status: 200, body: nonNull };
  }

  const response = await handleMcpJsonRpc(scope, payload as Record<string, unknown>);
  // Notifications get no body — 202 Accepted, per the Streamable HTTP transport.
  if (response === null) return { status: 202 };
  return { status: 200, body: response };
}
