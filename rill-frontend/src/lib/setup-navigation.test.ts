import { describe, expect, it } from "vitest";
import { canVisitSetupStep } from "./setup-navigation";
const agent = `0x${"2".repeat(64)}`;
describe("guided budget setup", () => {
  it("keeps a committed setup on approval so changing visible form values cannot misrepresent submitted limits", () => {
    expect(canVisitSetupStep("approve", "action", agent, true)).toBe(true);
    for (const step of ["action", "agent", "budget"] as const) {
      expect(canVisitSetupStep(step, "action", agent, true)).toBe(false);
    }
  });
  it("requires an action before choosing an agent and a complete signer before configuring spending", () => {
    expect(canVisitSetupStep("action", "", "", false)).toBe(true);
    expect(canVisitSetupStep("agent", "", agent, false)).toBe(false);
    expect(canVisitSetupStep("agent", "action", "", false)).toBe(true);
    expect(canVisitSetupStep("budget", "action", "0x2", false)).toBe(false);
    expect(canVisitSetupStep("budget", "action", agent, false)).toBe(true);
  });
  it("does not guide the owner into granting its own key agent authority", () => {
    expect(canVisitSetupStep("budget", "action", agent, false, agent)).toBe(false);
  });
});

import { budgetFormError, suiToMist } from "./setup-navigation";
it("rejects widening published spending limits before review, using exact units", () => {
  const limits = { budgetLimitMist: "15000000", perTxLimitMist: "10000000" };
  expect(budgetFormError("0.015", "0.01", "24", limits)).toBeNull();
  expect(budgetFormError("0.016", "0.01", "24", limits)).toContain("published limit");
  expect(budgetFormError("0.015", "0.011", "24", limits)).toContain("published limit");
  expect(budgetFormError("0.001", "0.01", "24", limits)).toContain("total budget");
  expect(budgetFormError("0.015", "0.01", "0", limits)).toContain("hours");
  expect(suiToMist("18446744073.709551615")).toBe(18446744073709551615n);
  expect(suiToMist("18446744073.709551616")).toBeNull();
});

it("prevents step navigation from bypassing action metadata and budget validation", () => {
  expect(
    canVisitSetupStep("agent", "action", agent, false, "owner", {
      hasActionOptions: false,
      budgetIsValid: true,
    }),
  ).toBe(false);
  expect(
    canVisitSetupStep("approve", "action", agent, false, "owner", {
      hasActionOptions: true,
      budgetIsValid: false,
    }),
  ).toBe(false);
  expect(
    canVisitSetupStep("budget", "action", agent, false, "owner", {
      hasActionOptions: true,
      budgetIsValid: false,
    }),
  ).toBe(true);
  expect(
    canVisitSetupStep("approve", "", "", true, "owner", {
      hasActionOptions: false,
      budgetIsValid: false,
    }),
  ).toBe(true);
});
