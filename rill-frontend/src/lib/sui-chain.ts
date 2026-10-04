import { SuiGrpcClient } from "@mysten/sui/grpc";
import { fromBase64 } from "@mysten/sui/utils";
import type { ObjectChange } from "./agent-wallet-tx";
import { SUI_NETWORK, SUI_NETWORKS } from "./sui-network";

/**
 * Submitting and confirming transactions over gRPC.
 *
 * Public fullnodes have switched JSON-RPC off on mainnet ("JSON-RPC on public fullnodes has been
 * deprecated. Please migrate to gRPC or GraphQL"), and dapp-kit 1.x executes and waits through a
 * JSON-RPC client. In a browser that surfaced as a bare "Failed to fetch" after the wallet had
 * already signed, so nothing reached the chain. The wallet still signs; this sends and confirms.
 */
let client: SuiGrpcClient | null = null;

export function suiGrpc(): SuiGrpcClient {
  client ??= new SuiGrpcClient({
    network: SUI_NETWORK,
    baseUrl: SUI_NETWORKS[SUI_NETWORK].url,
  });
  return client;
}

/** dapp-kit's `execute` hook: submit the bytes the wallet signed, over gRPC. */
export async function executeSigned({
  bytes,
  signature,
}: {
  bytes: string;
  signature: string;
}): Promise<{ digest: string }> {
  const result = await suiGrpc().executeTransaction({
    transaction: fromBase64(bytes),
    signatures: [signature],
  });
  const transaction = result.Transaction ?? result.FailedTransaction;
  return { digest: transaction.digest };
}

/** What the onboarding steps need to know about a submitted transaction once it is final. */
export type TransactionOutcome = {
  status: "success" | "failure";
  error?: string;
  /** Objects the transaction created, in the shape `harvestSetupObjects` reads. */
  objectChanges: ObjectChange[];
};

/** Wait until `digest` is final and report its status and the objects it created. */
export async function waitForOutcome(digest: string): Promise<TransactionOutcome> {
  const result = await suiGrpc().waitForTransaction({
    digest,
    timeout: 60_000,
    include: { effects: true, objectTypes: true },
  });
  const transaction = result.Transaction ?? result.FailedTransaction;
  const types = transaction.objectTypes ?? {};
  const objectChanges: ObjectChange[] = (transaction.effects?.changedObjects ?? [])
    .filter((change) => change.idOperation === "Created")
    .map((change) => ({
      type: "created",
      objectId: change.objectId,
      objectType: types[change.objectId],
    }));
  return transaction.status.success
    ? { status: "success", objectChanges }
    : { status: "failure", error: transaction.status.error.message, objectChanges };
}
