# Getting started

Rill lets an AI agent run approved Sui actions within a spending budget. You build the action and approve its limits. Your browser wallet keeps ownership of the vault; the agent uses its own local signer.

## Build an action

Open [Builder](/builder). Add a Cetus swap, Haedal stake, or DeepBook limit order. Connect the flow and preview it before publishing.

## Set the budget in Builder

Open Budget & permissions. Set the spending ceiling and any additional restrictions. Publishing saves an immutable action version with those limits.

## Approve funding

After publishing, choose Approve this action's budget. Select your connected agent, choose how much to fund within the published limits, and review the quote. Your wallet approves vault creation, rules and funding, and finally agent access.

## Run the action

Install the Rill plugin in your agent runtime. Ask it to list its Rill actions and run the approved action. The native signer checks the grant and performs a fresh simulation before submission.

## Stop access

Open [Agents](/agent-wallet) and choose Revoke & reclaim. This stops spending from that vault and returns its unused funds. Approved spending limits are not a live remaining-balance display.
