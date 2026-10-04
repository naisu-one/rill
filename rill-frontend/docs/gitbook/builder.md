# Builder

Build the workflow and its spending rules in one place.

## Available actions

Studio compiles Cetus swaps, Haedal stakes, and DeepBook limit orders. Select an action from the library or use a template. Amounts can be supplied at runtime, within the approved limits.

## Budget & permissions

The total budget is the lifetime spending ceiling of the vault. Maximum per run limits one execution. Rate and time limits, asset scopes, and other published restrictions remain part of the action's policy.

Owner funding can narrow published limits. It cannot expand them. A new action version requires fresh approval; existing grants keep their original workflow.

## Preview

Preview builds an unsigned PTB. Anonymous previews do not prove ownership, gas, or funded-vault caps. They are explicitly marked unverified. The local signer must perform a fresh verified simulation before execution.

## Publish

Publish with your owner wallet. Review the action, then choose Approve this action's budget to connect its agent and fund the vault. Publishing itself does not transfer funds.

## Discover contracts

Discover / Import reads a package's public ABI. Imported functions are useful for inspection. Arbitrary ABI functions are not automatically executable, and the compiler refuses unsupported actions.
