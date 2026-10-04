# Supported actions

## Studio

- Cetus: swap tokens in SUI-funded flows.
- Haedal: stake SUI and receive haSUI.
- DeepBook: place a limit order with a funded BalanceManager and delegated trading capabilities.

Cetus liquidity provision, lending, NFTs, bridges, oracle actions, and name-service actions are not executable Studio integrations yet. Navi, Scallop, BlueMove, Pyth, SuiNS, and Wormhole must not be treated as supported because their ABIs can be discovered.

## Native signer tools

The signer additionally supports bounded sends, direct token-balance portfolio reads, and instant redemption of owned haSUI. Delayed unstake/claim and lending workflows are outside the current MVP.
