# Using the agent plugin

## Install Rill

Install the Rill plugin from the rifuki/rill marketplace in your supported agent client. The launcher downloads the native signer and verifies a pinned checksum before starting MCP.

The hosted API constructs unsigned transactions and holds no wallet keys. Signing runs locally in the agent runtime.

## Check readiness

Run the installed signer to inspect its public address, network, and readiness:

```sh
~/.rill/bin/rill-wallet status
```

A valid owner-signed grant allows rill_run_action without a global run-set. Generic rill_execute requires a run-set. Mainnet signing also requires explicit local configuration.

## Execute

Ask the agent to list its Rill actions, choose the intended action and vault, then run it. Budget exhaustion, revocation, altered grants, and a minimum-output failure result in refusal. Do not automatically lower the owner's floor or bypass a refusal.
