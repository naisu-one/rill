import { ConnectModal, useCurrentAccount, useDisconnectWallet } from "@mysten/dapp-kit";
import { ChevronDown, LogOut, Wallet } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { shortAddress } from "@/lib/setup-navigation";
const style =
  "inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-foreground transition hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";
export function WalletControl() {
  const account = useCurrentAccount();
  const { mutate: disconnect, isPending } = useDisconnectWallet();
  if (!account)
    return (
      <ConnectModal
        trigger={
          <button
            type="button"
            className={`${style} !border-foreground !bg-foreground !text-background`}
          >
            <Wallet className="h-3.5 w-3.5" />
            Connect wallet
          </button>
        }
      />
    );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={style} aria-label="Wallet menu">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          <span>{shortAddress(account.address)}</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-4">
        <p className="text-xs font-semibold">Your owner wallet</p>
        <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
          {account.address}
        </p>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Approves funding and revokes agent access.
        </p>
        <button
          type="button"
          disabled={isPending}
          onClick={() => disconnect()}
          className="mt-4 inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <LogOut className="h-3.5 w-3.5" />
          Disconnect
        </button>
      </PopoverContent>
    </Popover>
  );
}
