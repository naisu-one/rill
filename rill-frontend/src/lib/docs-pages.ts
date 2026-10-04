import gettingStarted from "../../docs/gitbook/README.md?raw";
import builder from "../../docs/gitbook/builder.md?raw";
import agents from "../../docs/gitbook/agents.md?raw";
import permissions from "../../docs/gitbook/permissions.md?raw";
import supported from "../../docs/gitbook/supported-actions.md?raw";
import mcp from "../../docs/gitbook/mcp.md?raw";
export const DOC_PAGES = [
  { id: "getting-started", title: "Getting started", content: gettingStarted },
  { id: "builder", title: "Builder", content: builder },
  { id: "agents", title: "Agents", content: agents },
  { id: "permissions", title: "Spending permissions", content: permissions },
  { id: "supported-actions", title: "Supported actions", content: supported },
  { id: "mcp", title: "Using the agent plugin", content: mcp },
];
export const docAnchor = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
