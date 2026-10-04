# Agents

The agent holds its own signer key. Your browser wallet owns the spending vault and retains approval and revocation controls.

## Connect once

Existing paired signers appear when you load your owned actions. A single signer for the current owner and network is selected automatically. Use Connect a new agent only when registering another runtime.

The signer proves a server challenge locally. The owner confirms the pairing. Pairing by itself gives no spending permission. Never paste a private key or recovery phrase into Studio.

## Approve access

The setup has three explicit approvals: create an empty vault, install its rules and fund it, then sign the action grant. If interrupted, return with the same owner wallet to resume the saved setup.

## Revoke and reclaim

Revoke & reclaim stops the vault and returns its unused balance to its owner. Vaults created in this browser remain in Your saved budgets. Technical object IDs and exports are inside the details section.
