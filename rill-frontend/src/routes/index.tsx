import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Bot, Check, ShieldCheck, Workflow, Wallet, Zap } from "lucide-react";
import { SiteHeader, SiteFooter } from "@/components/site-chrome";
import { ProtocolLogo } from "@/components/flow/protocol-logo";
export const Route = createFileRoute("/")({ component: Landing });
const actions = [
  { protocol: "cetus", name: "Swap", description: "Trade SUI and USDC with Cetus." },
  { protocol: "haedal", name: "Stake", description: "Stake SUI with Haedal." },
  { protocol: "deepbook", name: "Place an order", description: "Create a DeepBook limit order." },
];
function Landing() {
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 sm:px-6">
        <section className="grid items-center gap-10 py-12 lg:grid-cols-[1.1fr_1fr] lg:gap-16 lg:py-20">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary">
              <ShieldCheck className="h-3.5 w-3.5" />
              Sui actions with spending limits
            </span>
            <h1 className="mt-6 max-w-xl text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl lg:text-6xl">
              Give your agent an action.
              <br />
              <span className="text-primary">Keep control of the budget.</span>
            </h1>
            <p className="mt-6 max-w-lg text-base leading-relaxed text-muted-foreground">
              Build a Sui workflow, connect your agent, and approve what it can spend. Your wallet
              keeps the power to revoke access and reclaim unused funds.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                to="/builder"
                className="inline-flex items-center gap-2 rounded-xl bg-foreground px-5 py-3 text-sm font-medium text-background transition hover:opacity-90"
              >
                Build an action
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/agent-wallet"
                search={{ action: undefined }}
                className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-5 py-3 text-sm font-medium transition hover:border-primary/40"
              >
                Manage agents
                <Bot className="h-4 w-4" />
              </Link>
            </div>
            <div className="mt-6 flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5 text-primary" />
                Your wallet stays yours
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5 text-primary" />
                Agent signs locally
              </span>
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">From workflow to execution</h2>
              <span className="rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                You approve
              </span>
            </div>
            <ol className="mt-7 space-y-0">
              {[
                {
                  Icon: Workflow,
                  title: "Build an action",
                  body: "Choose actions, connect them, and publish your flow.",
                },
                {
                  Icon: Bot,
                  title: "Choose your agent",
                  body: "Connect its own signer once and reuse it.",
                },
                {
                  Icon: Wallet,
                  title: "Set a spending budget",
                  body: "Approve a total limit, a per-run cap, and an expiry.",
                },
                {
                  Icon: Zap,
                  title: "Let your agent run",
                  body: "Use the Rill plugin to execute the approved action.",
                },
              ].map(({ Icon, title, body }, i) => (
                <li key={title} className="relative flex gap-4 pb-7 last:pb-0">
                  {i < 3 && (
                    <span className="absolute left-4 top-9 h-[calc(100%-2.25rem)] w-px bg-border" />
                  )}
                  <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
                    <Icon className="h-4 w-4" />
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold">{title}</h3>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-7 flex gap-2 rounded-xl bg-primary/5 p-3 text-xs leading-relaxed text-primary">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
              You can stop the agent and recover the vault's unused funds.
            </div>
          </div>
        </section>
        <section className="border-t border-border py-10">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-primary">
                Ready to build
              </p>
              <h2 className="mt-2 text-xl font-semibold">Start with a supported action</h2>
            </div>
            <Link
              to="/protocols"
              className="inline-flex items-center gap-2 text-sm font-medium text-primary"
            >
              Explore protocols
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {actions.map((action) => (
              <Link
                key={action.protocol}
                to="/builder"
                className="group rounded-xl border border-border bg-card p-5 transition hover:border-primary/40 hover:shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <ProtocolLogo
                    protocolId={action.protocol}
                    name={action.protocol}
                    className="h-8 w-8"
                  />
                  <ArrowRight className="h-4 w-4 text-muted-foreground transition group-hover:text-primary" />
                </div>
                <h3 className="mt-5 text-sm font-semibold">{action.name}</h3>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {action.description}
                </p>
              </Link>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
