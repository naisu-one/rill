import { findToken } from "../../../packages/rill-sdk/src";
import { assertBackendNetwork } from "./sui-network";

export type ProtocolRegistry = {
  network: string;
  cetus_swap: {
    integratePackageId: string;
    globalConfigId: string;
    defaultPoolId: string;
    defaultInputCoinType: string;
    tokens: { symbol: string; coinType: string }[];
    minSqrtPrice: string;
    maxSqrtPrice: string;
  };
  haedal_stake: {
    packageId: string;
    stakeTarget: string;
    suiSystemStateId: string;
    stakingObjectId: string;
    minStakeMist: string;
    coinType: string;
  };
  deepbook_limit_order: { pools: string[] };
};

/** Validate before installing any address so a partial response cannot mix networks. */
export function validateProtocolRegistry(value: unknown): ProtocolRegistry {
  const registry = value as ProtocolRegistry;
  assertBackendNetwork(registry?.network);
  const cetus = registry?.cetus_swap;
  const haedal = registry?.haedal_stake;
  const id = (value: unknown) => typeof value === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(value);
  const positive = (value: unknown) => typeof value === "string" && /^[1-9]\d*$/.test(value);
  const tokens = Array.isArray(cetus?.tokens)
    ? cetus.tokens.filter((token) => token && typeof token.symbol === "string" && typeof token.coinType === "string")
    : [];
  const sui = tokens.find((token) => token.symbol === "SUI")?.coinType;
  const usdc = tokens.find((token) => token.symbol === "USDC")?.coinType;
  const pools = registry?.deepbook_limit_order?.pools;
  const defaultPool = registry?.network === "mainnet" ? "SUI_USDC" : "SUI_DBUSDC";
  if (
    !cetus || !haedal ||
    !id(cetus.integratePackageId) || !id(cetus.globalConfigId) || !id(cetus.defaultPoolId) ||
    !positive(cetus.minSqrtPrice) || !positive(cetus.maxSqrtPrice) ||
    BigInt(cetus.minSqrtPrice) >= BigInt(cetus.maxSqrtPrice) ||
    sui !== "0x2::sui::SUI" || !usdc || findToken(usdc)?.decimals !== 6 ||
    !tokens.some((token) => token.coinType === cetus.defaultInputCoinType) ||
    !id(haedal.packageId) || haedal.stakeTarget !== `${haedal.packageId}::interface::request_stake` ||
    !id(haedal.suiSystemStateId) || !id(haedal.stakingObjectId) ||
    !positive(haedal.minStakeMist) || haedal.coinType !== sui ||
    !Array.isArray(pools) || !pools.every((pool) => typeof pool === "string") ||
    !pools.includes(defaultPool)
  ) {
    throw new Error(`Incomplete or invalid ${registry?.network} protocol registry.`);
  }
  return registry;
}
