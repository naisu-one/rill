# Guided Product Redesign Implementation Plan

> **For agentic workers:** Execute inline using the existing frontend and transaction controller. Owner approvals remain explicit. Do not change Move contracts or grant authority.

**Goal:** Replace the crowded technical form with a guided action-to-agent-to-budget-to-approval journey and a consistent product interface.

**Architecture:** Keep transaction construction, owner signing, quote enforcement, recovery persistence and revocation in the current route controller. Add small presentation components and explicit navigation state. Preserve existing grants and pair records.

**Tech Stack:** React, TanStack Router, Tailwind, dapp-kit, existing Rust production API.

## Design

Use canvas #F5F8FA, ink #18323B, surface #FFFFFF, teal #128378, mint #E3F5EE and line #DEE7EB. Use Inter for interface/display and the system monospace stack only inside technical disclosures. The signature is the visible permission journey: build an action, connect its agent, approve a bounded budget, run it. Main pages have one primary task and one primary button.

## Task 1: navigation and state boundaries

Files: src/lib/setup-navigation.ts and its test, src/routes/agent-wallet.tsx.

- [ ] Define the actual step union and navigation gate:

```ts
export type SetupStep = "action" | "agent" | "budget" | "approve";
export const SETUP_STEPS: SetupStep[] = ["action", "agent", "budget", "approve"];
export function canVisitSetupStep(step: SetupStep, action: string, agent: string, committed: boolean): boolean {
  if (committed) return step === "approve";
  if (step === "action") return true;
  if (!action) return false;
  return step === "agent" || /^0x[0-9a-fA-F]{64}$/.test(agent);
}
```

- [ ] Test that committed setup cannot return to editable steps, missing action cannot advance, and incomplete agent cannot advance to budget/approval. Run npm test before changing controller behavior.
- [ ] Track step and action-list completion per owner. Reset owner-specific UI selections on owner switch. Derive approval from persisted pending setup/prepared grant so reload recovery still works.

## Task 2: guided wallet page

Files: src/routes/agent-wallet.tsx, src/components/signer-pairing.tsx.

- [ ] Initial gateway uses one Continue button to authenticate and load actions and pair records together. Do not open a signing prompt on mount.
- [ ] Action screen uses readable action cards, names and version badges instead of raw IDs. Empty state links to Builder. Agent screen shows a short signer label; public-address pairing stays in a deliberate new-agent disclosure.
- [ ] Budget screen exposes total budget, per-action cap and expiry. Order-price override stays advanced. Review shows action, signer, limits and a read-only quote before an explicit creation request.
- [ ] Approval screen explains the three actual approvals: create the empty vault, fund with its rules, activate its grant. Keep submitted transaction IDs in details and keep retry/recovery buttons available. Show the exact prepared permission text before signing.
- [ ] Funded budget cards show approval state, fixed limits and Revoke/reclaim as the primary management control. Put technical object IDs and downloaded run-set/build arguments in details.

## Task 3: product identity and homepage

Files: src/styles.css, src/components/site-chrome.tsx, src/routes/index.tsx.

- [ ] Replace the ambient pastel gradient with a calm neutral canvas and white task surfaces. Use restrained teal for the current step and permissions.
- [ ] Main navigation becomes Builder, Agents, Protocols, Docs. All links remain visible and fit320px.
- [ ] Replace the decorative unsupported-protocol flow on the homepage with working start points and the real supported Cetus/Haedal/DeepBook actions. Make Build an action and Manage agents the direct calls to action.

## Task 4: builder clarity

File: src/routes/builder.tsx.

- [ ] Replace low-level PTB/move-count copy with action count; retain exact compilation behavior. Rename Compile/export to Publish action.
- [ ] Remove drifting background blobs, keep functional canvas controls, and add a clear path from editing to preview, publish, then Agents. Preserve draft storage and node/edge semantics.

## Task 5: proof and release

- [ ] Run node node_modules/typescript/bin/tsc --noEmit, scoped ESLint, npm test, and production build. Expected: no type/lint failures and existing tests stay green.
- [ ] Browser-check authentication gateway, each editable step, disabled progression, shortened addresses, persisted pending setup, grant review, revocation visibility, homepage calls to action, builder preview/publish, and320px/375px navigation. Use a separate localhost origin to preserve the user's production draft.
- [ ] Obtain native source review of owner-switch races, quote gating and recovery before shipping. Do not submit a financial transaction for visual testing.
- [ ] Stage only redesign-owned paths, commit with configured author, push own main ref, deploy Tencent and Vercel, verify actual production navigation and screenshot. Preserve foreign image deletions and warden.html.
