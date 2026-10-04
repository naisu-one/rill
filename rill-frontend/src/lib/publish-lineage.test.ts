import { describe, expect, it } from "vitest";
import { parentPublication } from "./publish-lineage";
import type { PublishResult } from "./rill-api";

const previous = {
  skillId: "skill_v1",
  owner: "0xABC",
  mcpUrl: "https://rill.test/api/mcp/skill_v1",
} as PublishResult;
describe("publication lineage", () => {
  it("extends the authenticated owner's publication on the same server", () => {
    expect(parentPublication(previous, "0xabc", "https://rill.test/api")).toBe("skill_v1");
  });
  it("never binds an anonymous, another owner's, or another deployment's draft", () => {
    expect(parentPublication(previous, undefined, "https://rill.test/api")).toBeUndefined();
    expect(parentPublication(previous, "0xdef", "https://rill.test/api")).toBeUndefined();
    expect(parentPublication(previous, "0xabc", "https://other.test/api")).toBeUndefined();
    expect(
      parentPublication({ ...previous, owner: undefined }, "0xabc", "https://rill.test/api"),
    ).toBeUndefined();
  });
});
