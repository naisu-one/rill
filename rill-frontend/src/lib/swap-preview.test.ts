import { expect, it } from "vitest";
import { formatQuotedAmount } from "./swap-preview";
it("shows known asset amounts without floating-point conversion or guessing other coins", () => {
  const usdc = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
  expect(formatQuotedAmount(usdc, "5873")).toBe("0.005873 USDC");
  expect(formatQuotedAmount(usdc, "10000")).toBe("0.01 USDC");
  expect(formatQuotedAmount("0x2::sui::SUI", "5000000")).toBe("0.005 SUI");
  expect(formatQuotedAmount("0xdead::usdc::USDC", "10000")).toBe("10000 base units");
});
