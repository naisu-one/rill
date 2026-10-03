export type SuiNetwork = "testnet" | "mainnet";

function resolveSuiNetwork(): SuiNetwork {
  const configured = import.meta.env.VITE_SUI_NETWORK || "testnet";
  if (configured !== "testnet" && configured !== "mainnet") {
    throw new Error("VITE_SUI_NETWORK must be testnet or mainnet.");
  }
  return configured;
}

export const SUI_NETWORK = resolveSuiNetwork();
export const SUI_NETWORKS = {
  testnet: { url: "https://fullnode.testnet.sui.io:443", network: "testnet" as const },
  mainnet: { url: "https://fullnode.mainnet.sui.io:443", network: "mainnet" as const },
};

export function assertBackendNetwork(network: unknown): void {
  if (network !== SUI_NETWORK) {
    throw new Error(
      `Backend network ${String(network ?? "(missing)")} does not match Studio network ${SUI_NETWORK}.`,
    );
  }
}
