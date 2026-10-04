import { PROTOCOLS } from "./protocols";
const actions: Record<string, readonly string[]> = {
  cetus: ["swap"],
  haedal: ["stake"],
  deepbook: ["limit_order"],
};
export const STUDIO_PROTOCOLS = PROTOCOLS.filter((protocol) => protocol.id in actions).map(
  (protocol) => ({
    ...protocol,
    actions: protocol.actions.filter((action) => actions[protocol.id].includes(action.id)),
  }),
);
