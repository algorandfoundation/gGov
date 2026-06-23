import { ListOrdered, Minus } from "lucide-react";
import { Avatar, avatarTone } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export interface CouncilCandidate {
  /** Candidate handle — the topic title. */
  name: string;
  yes: number;
  no: number;
  abstain: number;
}

interface CouncilResultsProps {
  candidates: CouncilCandidate[];
  /** Seats being elected (`electSeats`). The top `threshold` lead. */
  threshold: number;
  /** Active period → in-progress framing (ranking may still change). */
  live?: boolean;
}

/**
 * Election results: candidates ranked by net score (Yes − No; Abstain has
 * no effect), with the top `threshold` marked "Leading" and a cutoff divider drawn
 * after rank N. Diverging score bars are centered on a zero axis (positive right,
 * negative left). Provisional language only — ranking, never seating verdicts.
 */
export default function CouncilResults({ candidates, threshold, live }: CouncilResultsProps) {
  const scored = candidates
    .map((c) => ({ ...c, score: c.yes - c.no }))
    .sort((a, b) => b.score - a.score);
  const maxAbs = Math.max(1, ...scored.map((c) => Math.abs(c.score)));
  const seatsLabel = `${threshold} seat${threshold === 1 ? "" : "s"}`;

  return (
    <div>
      {/* result summary callout — blue (provisional), not a green verdict */}
      <div className="flex items-center gap-3.5 rounded-md border border-border border-l-[3px] border-l-algo-blue bg-card px-5 py-4">
        <span className="grid size-[38px] shrink-0 place-items-center rounded-full bg-primary/10 text-algo-blue dark:bg-algo-teal/15 dark:text-algo-teal">
          <ListOrdered className="size-5" />
        </span>
        <div className="min-w-0">
          <div className="font-display text-base font-bold">Ranked for {seatsLabel}</div>
          <div className="mt-0.5 text-[13.5px] text-muted-foreground">
            Candidates are ranked by net score. The top <strong className="text-foreground">{threshold}</strong> lead
            for the available seats.
          </div>
        </div>
      </div>

      {/* column header (desktop) */}
      <div className="mt-7 hidden grid-cols-[30px_1fr_minmax(160px,220px)_84px] items-end gap-3.5 border-b border-border px-[18px] pb-2.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground sm:grid">
        <span>#</span>
        <span>Candidate</span>
        <span>Net score (Yes − No)</span>
        <span className="text-right">Score</span>
      </div>

      {/* ranked rows */}
      <div className="overflow-hidden rounded-b-xl border border-t-0 border-border sm:rounded-b-xl">
        {scored.map((c, i) => {
          const rank = i + 1;
          const leading = rank <= threshold;
          const neg = c.score < 0;
          const half = Math.round((Math.abs(c.score) / maxAbs) * 50);
          const showCutoff = rank === threshold && rank < scored.length;
          return (
            <div key={`${c.name}-${i}`}>
              <div
                className={cn(
                  "grid grid-cols-[28px_1fr_auto] items-center gap-3 border-b border-border px-3.5 py-3.5 sm:grid-cols-[30px_1fr_minmax(160px,220px)_84px] sm:gap-3.5 sm:px-[18px]",
                  leading ? "bg-primary/5" : "bg-card",
                )}
              >
                <span
                  className={cn(
                    "text-center font-display text-base font-bold tabular-nums",
                    leading ? "text-algo-blue" : "text-muted-foreground",
                  )}
                >
                  {rank}
                </span>
                <div className="flex min-w-0 items-center gap-2.5">
                  <Avatar name={c.name} tone={avatarTone(c.name)} size={32} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-semibold">{c.name}</span>
                      {leading && (
                        <span className="shrink-0 rounded-full border border-algo-blue/30 bg-card px-[7px] py-[2px] text-[10.5px] font-semibold tracking-[0.03em] text-algo-blue dark:border-algo-teal/40 dark:text-algo-teal">
                          Leading
                        </span>
                      )}
                    </div>
                    <div className="text-[12px] tabular-nums text-muted-foreground">
                      Yes {c.yes.toLocaleString()} · No {c.no.toLocaleString()} · Abstain {c.abstain.toLocaleString()}
                    </div>
                  </div>
                </div>
                {/* diverging score bar (desktop) */}
                <div className="relative hidden h-3.5 rounded bg-muted/50 sm:block">
                  <div className="absolute -bottom-[3px] -top-[3px] left-1/2 w-px bg-border" />
                  {neg ? (
                    <div
                      className="absolute bottom-0 right-1/2 top-0 rounded-l-[3px]"
                      style={{ width: `${half}%`, background: "#E79B7A" }}
                    />
                  ) : (
                    <div
                      className={cn(
                        "absolute bottom-0 left-1/2 top-0 rounded-r-[3px]",
                        leading ? "bg-algo-blue" : "bg-algo-navy-40",
                      )}
                      style={{ width: `${half}%` }}
                    />
                  )}
                </div>
                <span
                  className={cn(
                    "text-right font-display text-xl font-bold tabular-nums",
                    !neg && leading && "text-algo-blue",
                    !neg && !leading && "text-muted-foreground",
                  )}
                  style={neg ? { color: "#C24A1E" } : undefined}
                >
                  {(neg ? "−" : "+") + Math.abs(c.score).toLocaleString()}
                </span>
              </div>
              {showCutoff && (
                <div className="flex items-center gap-3 bg-algo-blue px-[18px] py-2.5">
                  <span className="inline-flex shrink-0 items-center gap-1.5 font-display text-xs font-bold tracking-[0.03em] text-white">
                    <Minus className="size-3.5" />
                    {seatsLabel} — cutoff
                  </span>
                  <span className="h-px flex-1 bg-white/25" />
                  <span className="shrink-0 text-[11.5px] text-white/70">Below the cutoff line</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-[12px] text-muted-foreground">
        Score = total Yes votes minus total No votes. Abstain votes don't change a candidate's score.{" "}
        {live ? "Live tallies — recorded on-chain; ranking may change." : "Final tallies recorded on-chain."}
      </p>
    </div>
  );
}
