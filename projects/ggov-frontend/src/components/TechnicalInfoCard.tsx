import { Eyebrow } from "@/components/ui/eyebrow";
import AppExplorerLink from "@/components/AppExplorerLink";
import { usePeriodAppId } from "@/hooks/queries";
import { getAlgodConfigFromViteEnvironment } from "@/utils/network";
import { cn } from "@/lib/utils";

/** Registry app the dApp is pointed at; shared across every period. */
const registryAppId = import.meta.env.VITE_GGOV_REGISTRY_APP_ID;

/**
 * On-chain references for the period: its GGovPeriod app, the registry app it
 * belongs to (both linking to a block explorer), and the network it lives on.
 * Styled to match {@link PeriodInfoCard}.
 */
export default function TechnicalInfoCard({ periodId, className }: { periodId: number; className?: string }) {
  const network = getAlgodConfigFromViteEnvironment().network;
  const { data: periodAppId } = usePeriodAppId(periodId);

  return (
    <div className={cn("flex flex-col gap-4 rounded-xl border border-border bg-card p-5", className)}>
      <Eyebrow>Technical information</Eyebrow>
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] text-muted-foreground">Period {periodId} App</span>
          {periodAppId !== undefined ? (
            <AppExplorerLink appId={periodAppId} className="text-sm font-medium" />
          ) : (
            <span className="text-sm font-medium tabular-nums">—</span>
          )}
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] text-muted-foreground">Registry App</span>
          {registryAppId ? (
            <AppExplorerLink appId={registryAppId} className="text-sm font-medium" />
          ) : (
            <span className="text-sm font-medium tabular-nums">—</span>
          )}
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] text-muted-foreground">Network</span>
          <span className="text-sm font-medium capitalize">{network}</span>
        </div>
      </div>
    </div>
  );
}
