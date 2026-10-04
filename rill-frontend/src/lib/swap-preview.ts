import { baseUnitsToDecimal } from "./capabilities";

const MAINNET_USDC =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const TESTNET_USDC =
  "0x14a71d857b34677a7d57e0feb303df1adb515a37780645ab763d42ce8d1a5e48::usdc::USDC";

export function formatQuotedAmount(type: string, units: string): string {
  const normalized = type.replace(/^0x0+([0-9a-f]+)::/, "0x$1::");
  if (normalized === "0x2::sui::SUI") return `${baseUnitsToDecimal(units, 9)} SUI`;
  if (normalized === MAINNET_USDC || normalized === TESTNET_USDC) {
    return `${baseUnitsToDecimal(units, 6)} USDC`;
  }
  return `${units} base units`;
}
