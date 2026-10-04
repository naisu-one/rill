# Spending permissions

## Budget and per-run caps

Studio reads the published action's limits before setup. Suggested funding amounts fit those limits. A user can choose less; a wider budget is rejected.

## Protected swaps

Single-Cetus protected swaps restrict the adapter, pool, output asset, policy revision, and minimum output. Proceeds settle to the owner and unused input stays in the vault.

The funding preview reads a live quote without submitting a transaction. If the quote is below the published minimum, setup is refused before creation or funding. Prices can change later; the contract checks actual output at execution.

## Other flows

Budget, per-transaction, rate and time rules are enforced on chain. Some protocol, asset and recipient restrictions rely on the compiler and native signer. Legacy bounded flows do not have the same settlement guarantees as the protected swap adapter.

## Expiry and versions

An expired or revoked grant cannot be executed by the Rill signer. Publishing an edited flow creates a new immutable version. Upgradeable Move packages remain separate from action-version approval.
