import { Link } from "@tanstack/react-router";
import { WalletControl } from "@/components/wallet-control";
import { RillMark } from "@/components/rill-mark";
import { SUI_NETWORK } from "@/lib/sui-network";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 backdrop-blur-md bg-background/70 border-b border-border/60">
      <div className="mx-auto max-w-6xl px-3 sm:px-6 min-h-16 py-2 flex flex-wrap items-center gap-2">
        <Link to="/" className="flex items-center gap-2 cursor-pointer">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <RillMark className="h-4 w-4" />
          </span>
          <span className="text-xl font-semibold tracking-tight">Rill</span>
          <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            {SUI_NETWORK}
          </span>
        </Link>
        <nav
          aria-label="Main navigation"
          className="order-3 flex w-full flex-wrap items-center justify-center gap-1 text-sm sm:order-none sm:ml-auto sm:w-auto"
        >
          {(
            [
              { to: "/builder", label: "Builder" },
              { to: "/agent-wallet", label: "Agents" },
              { to: "/protocols", label: "Protocols" },
              { to: "/docs", label: "Docs" },
            ] as const
          ).map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="rounded-lg px-3 py-2 font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
              activeProps={{ className: "bg-primary/10 text-primary", "aria-current": "page" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <span className="ml-auto sm:ml-2">
          <WalletControl />
        </span>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-border/60">
      <div className="mx-auto max-w-6xl px-6 py-10 flex flex-wrap items-center justify-between gap-4 text-sm text-muted-foreground">
        <div>© {new Date().getFullYear()} Rill</div>
        <div className="flex gap-4">
          <a
            href="https://sui.io"
            target="_blank"
            rel="noreferrer"
            className="cursor-pointer hover:text-foreground"
          >
            Sui
          </a>
          <a
            href="https://modelcontextprotocol.io"
            target="_blank"
            rel="noreferrer"
            className="cursor-pointer hover:text-foreground"
          >
            MCP
          </a>
          <a
            href="https://github.com/rifuki/rill"
            target="_blank"
            rel="noreferrer"
            className="cursor-pointer hover:text-foreground"
          >
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
