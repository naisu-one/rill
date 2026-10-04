import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Check } from "lucide-react";
import { SiteHeader, SiteFooter } from "@/components/site-chrome";
import { ProtocolLogo } from "@/components/flow/protocol-logo";
import { STUDIO_PROTOCOLS } from "@/lib/supported-protocols";
export const Route = createFileRoute("/protocols")({
  head: () => ({ meta: [{ title: "Supported protocols | Rill" }] }),
  component: ProtocolsPage,
});
function ProtocolsPage() {
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">Integrations</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Supported protocols</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          These actions can be built, published, and granted from Studio. The catalog reflects the
          current compiler, not planned integrations.
        </p>
        <div className="mt-8 overflow-hidden rounded-xl border border-border bg-card">
          <div className="hidden grid-cols-[1fr_1fr_160px] gap-4 border-b border-border bg-muted/40 px-5 py-3 text-xs font-medium text-muted-foreground sm:grid">
            <span>Protocol</span>
            <span>Available action</span>
            <span>Status</span>
          </div>
          {STUDIO_PROTOCOLS.map((protocol) => (
            <div
              key={protocol.id}
              className="grid items-center gap-4 border-b border-border px-5 py-5 last:border-0 sm:grid-cols-[1fr_1fr_160px]"
            >
              <div className="flex items-center gap-3">
                <ProtocolLogo protocolId={protocol.id} name={protocol.name} className="h-8 w-8" />
                <div>
                  <p className="text-sm font-semibold">{protocol.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{protocol.category}</p>
                </div>
              </div>
              <div>
                <p className="text-sm">{protocol.actions[0].name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {protocol.id === "cetus"
                    ? "SUI-funded swap flows"
                    : protocol.id === "haedal"
                      ? "Stake SUI and receive haSUI"
                      : "Requires a funded BalanceManager"}
                </p>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1 text-xs text-primary">
                  <Check className="h-3.5 w-3.5" />
                  Available
                </span>
                <Link
                  to="/builder"
                  aria-label={`Build with ${protocol.name}`}
                  className="text-primary"
                >
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </div>
          ))}
        </div>
        <section className="mt-8 border-t border-border pt-6">
          <h2 className="text-sm font-semibold">What about other protocols?</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Navi, Scallop, BlueMove, Pyth, SuiNS, and Wormhole are not executable Studio
            integrations yet. Discover / Import can inspect public contract functions; importing an
            ABI does not make an unsupported action executable.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Signer tools also cover bounded sends, portfolio reads, and instant haSUI redemption.
            Those are separate from the Studio action catalog.
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
