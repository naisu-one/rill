import { Check, ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { SETUP_STEPS, type SetupStep } from "@/lib/setup-navigation";
const titles: Record<SetupStep, string> = {
  action: "Choose an action",
  agent: "Choose your agent",
  budget: "Set a budget",
  approve: "Review & approve",
};
export function SetupJourney({
  step,
  canVisit,
  onVisit,
  children,
}: {
  step: SetupStep;
  canVisit: (step: SetupStep) => boolean;
  onVisit: (step: SetupStep) => void;
  children: ReactNode;
}) {
  const index = SETUP_STEPS.indexOf(step);
  return (
    <div className="grid gap-6 md:grid-cols-[210px_minmax(0,1fr)]">
      <nav
        aria-label="Budget setup steps"
        className="flex gap-2 overflow-x-auto md:flex-col md:gap-3"
      >
        {SETUP_STEPS.map((item, i) => (
          <button
            type="button"
            key={item}
            onClick={() => onVisit(item)}
            disabled={!canVisit(item)}
            aria-current={step === item ? "step" : undefined}
            className={`flex shrink-0 items-center gap-3 rounded-xl px-3 py-3 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${step === item ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted"}`}
          >
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs ${step === item ? "border-primary bg-primary text-white" : "border-border bg-card"}`}
            >
              {i < index ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </span>
            <span>{titles[item]}</span>
          </button>
        ))}
      </nav>
      <section className="min-w-0 rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-8">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Step {index + 1} of 4
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">{titles[step]}</h2>
        <div className="mt-6 space-y-5">{children}</div>
      </section>
    </div>
  );
}
export function SetupNext({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-foreground px-5 py-3 text-sm font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
    >
      {children}
      <ArrowRight className="h-4 w-4" />
    </button>
  );
}
export function BudgetSummary({ children }: { children: ReactNode }) {
  return <dl className="grid gap-4 rounded-xl bg-muted/60 p-5 sm:grid-cols-2">{children}</dl>;
}
export function SummaryItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-sm font-semibold">{children}</dd>
    </div>
  );
}
