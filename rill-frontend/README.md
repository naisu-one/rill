# Rill Studio

Studio connects directly to the Rust `rill-server` at `http://localhost:3939`.
The TypeScript backend is not required.

1. Start the Rust server from the sibling `rill` repository using its documented testnet configuration.
2. Copy `.env.example` to `.env.local` in this directory, or set `VITE_RILL_API_URL` explicitly.
3. Run the workspace's frontend dev command and open the URL Vite prints.
4. Set the Rust server's `RILL_STUDIO_URL` to that same frontend origin so wallet consent redirects return here.

`VITE_RILL_API_URL` accepts either the server origin or its `/api` URL. Restart Vite after changing it. The default is `http://localhost:3939/api`; hosted environments must set their own URL at build time. The browser wallet provider uses Sui testnet.

In the builder, configure an action and its wallet capabilities, simulate it, then publish. A connected wallet signs the server's personal-message challenge to associate the published action with its owner. Capability changes require publishing a new version.

On the Agent wallet page, load your published actions and enter the agent's address and limits. The first transaction creates an empty wallet and any required DeepBook capabilities. The second transaction attaches the capability rules and funds the wallet atomically. Cancelling the second signature leaves no spending budget in the empty wallet. If confirmation is interrupted after funding was submitted, use **Check funding status** to confirm the same transaction. Keep the page open until setup is complete.

After funding is confirmed, download the run set for the Rust signer. The frontend fills no transaction bytes or local policy from guesses: the Rust backend returns BCS `TransactionKind` for wallet signing and the completed run set from confirmed setup object IDs.

Frontend checks use the installed binaries without invoking a package-manager bootstrap:

```sh
./node_modules/.bin/vitest run
./node_modules/.bin/vite build
```

After a grant is confirmed, download both the Rust run set and the build-arguments JSON. The run set is the local signer policy; build arguments carry the public object bindings for the published action. Do not merge these files: the Rust run-set schema intentionally rejects unknown fields.

With the local Rust server running, `bun scripts/rust-smoke.ts` checks wallet login, replay rejection, real testnet preview, publish/MCP, and empty-wallet setup bytes without submitting a transaction.
