/** Read-only chain smoke against a local Rust server. No transaction is signed or submitted. */
import assert from "node:assert/strict";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

const base = process.env.RILL_SMOKE_URL ?? "http://localhost:3939";
const wallet = new Ed25519Keypair();
const sender = wallet.toSuiAddress();
async function request(path: string, body?: unknown, token?: string) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`);
  return data.data ?? data;
}
assert.equal((await request("/health")).keyless, true);
const protocols = await request("/api/protocols");
assert.equal(protocols.network, "testnet");
const functions = await request("/api/introspect", { packageId: "0x2" });
assert(
  functions.some((f: { module: string; name: string }) => f.module === "coin" && f.name === "zero"),
);
const challenge = await request("/oauth/wallet-challenge");
const signed = await wallet.signPersonalMessage(new TextEncoder().encode(challenge.message));
const session = await request("/oauth/wallet-token", {
  challengeId: challenge.challengeId,
  signature: signed.signature,
});
assert.equal(session.address, sender);
const replay = await fetch(base + "/oauth/wallet-token", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ challengeId: challenge.challengeId, signature: signed.signature }),
});
assert(!replay.ok, "A challenge must be single-use");
const flow = {
  nodes: [
    { id: "stake", type: "haedal_stake", config: { amount: "1000000000", validator: "0x0" } },
  ],
  edges: [],
};
const manifest = {
  walletCoinType: "0x2::sui::SUI",
  rules: [
    { kind: "budget", totalMist: "1000000000" },
    { kind: "per_tx", maxMist: "1000000000" },
  ],
};
const preview = await request("/api/capabilities/preview", { manifest });
assert.equal(preview.onChainRules[0].config.totalMist, "1000000000");
const simulated = await request("/api/simulate", { flow });
assert.equal(simulated.simulation.ok, true, JSON.stringify(simulated.simulation));
assert.equal(simulated.simulation.verification, "unverified");
assert.equal(typeof simulated.simulation.gasEstimate, "string");
assert(Transaction.fromKind(simulated.unsignedPtb).getData().commands.length > 0);
const published = await request("/api/publish", { flow, manifest }, session.access_token);
const skills = await request("/api/skills", undefined, session.access_token);
assert(skills.some((s: { id: string }) => s.id === published.skillId));
const unowned = await request("/api/skills");
assert(!unowned.some((s: { id: string }) => s.id === published.skillId));
const mcp = await request(`/api/mcp/${published.skillId}`, {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
});
assert.equal(mcp.result.tools[0].name, "build_action");
const owned = await request(
  "/mcp",
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "rill_list_actions", arguments: {} },
  },
  session.access_token,
);
assert(
  JSON.parse(owned.result.content[0].text).actions.some(
    (a: { actionId: string }) => a.actionId === published.skillId,
  ),
);
const setup = await request(
  "/api/setup/prepare",
  {
    skillId: published.skillId,
    sender,
    agent: new Ed25519Keypair().toSuiAddress(),
    budgetMist: "1000000000",
    perTxMist: "1000000000",
    expiresAtMs: String(Date.now() + 3_600_000),
  },
  session.access_token,
);
const tx = Transaction.fromKind(setup.setupPtb).getData();
const targets = tx.commands.flatMap((c) => (c.MoveCall ? [c.MoveCall.function] : []));
assert(targets.includes("zero") && targets.includes("create_wallet"));
assert(!targets.includes("top_up"), "First setup step must not fund an unbounded wallet");
assert(!tx.commands.some((c) => c.SplitCoins), "First setup step must not split user funds");
console.log(
  JSON.stringify(
    {
      ok: true,
      backend: base,
      functions: functions.length,
      checks: [
        "wallet signature",
        "replay rejection",
        "capability preview",
        "real Haedal preview",
        "publish",
        "owner scope",
        "public MCP",
        "owner MCP",
        "empty-wallet setup BCS",
      ],
      transactionsSubmitted: 0,
    },
    null,
    2,
  ),
);
