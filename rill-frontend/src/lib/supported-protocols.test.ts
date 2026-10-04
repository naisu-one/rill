import { expect, it } from "vitest";
import { STUDIO_PROTOCOLS } from "./supported-protocols";
it("catalog and builder expose only executable Studio actions", () => {
  expect(
    STUDIO_PROTOCOLS.flatMap((protocol) =>
      protocol.actions.map((action) => `${protocol.id}:${action.id}`),
    ),
  ).toEqual(["cetus:swap", "haedal:stake", "deepbook:limit_order"]);
});
