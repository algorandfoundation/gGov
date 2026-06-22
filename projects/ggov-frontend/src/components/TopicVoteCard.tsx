import * as React from "react";
import { ClampedMarkdown } from "@/components/ui/clamped-markdown";
import { ProgressBar } from "@/components/ui/progress-bar";
import { cn } from "@/lib/utils";

export type TopicVoteMode = "upcoming" | "results" | "select" | "advanced";

interface TopicVoteCardProps {
  title?: string;
  /** Markdown topic description. */
  body?: string;
  options: string[];
  tallies: number[];
  mode: TopicVoteMode;
  /** Selected option index in `select` mode (-1 for none). */
  selectedOption?: number;
  onSelect?: (optionIdx: number) => void;
  /** Per-option vote allocation in `advanced` mode. */
  advancedVotes?: number[];
  onAdvancedChange?: (optionIdx: number, value: number) => void;
  /** Voting power of the active voter — drives advanced allocation % and the simple "All N votes" note. */
  votingPower?: number;
  /** Option the connected voter recorded a vote for (`results` mode "YOUR VOTE" tag). */
  votedOptionIdx?: number;
  /** Footer node, e.g. an allocation summary in `advanced` mode. */
  footer?: React.ReactNode;
  topicIdx: number;
}

/** Small uppercase pill used for LEADING / YOUR VOTE tags in results mode. */
function ResultTag({ tone, children }: { tone: "lead" | "you"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-[7px] py-[2px] text-[10.5px] font-semibold tracking-[0.03em]",
        tone === "lead"
          ? "bg-success/[0.14] text-success-strong"
          : "bg-primary/10 text-primary dark:bg-algo-teal/15 dark:text-algo-teal",
      )}
    >
      {children}
    </span>
  );
}

/**
 * Voting topic card: a header band (mono `T.0N` index pill + title) over option
 * rows rendered in one of four modes — `upcoming` (plain list), `results`
 * (read-only tally bars with leading/your-vote tags), `select` (single-choice
 * radio cards), and `advanced` (per-option allocation inputs).
 */
export default function TopicVoteCard({
  title,
  body,
  options,
  tallies,
  mode,
  selectedOption = -1,
  onSelect,
  advancedVotes,
  onAdvancedChange,
  votingPower,
  votedOptionIdx,
  footer,
  topicIdx,
}: TopicVoteCardProps) {
  const totalVotes = tallies.reduce((a, b) => a + b, 0);
  // Highlight the leading option even when it's under 50%; if several options
  // tie for the lead, all of them are highlighted.
  const leadingTally = Math.max(0, ...tallies);
  const indexLabel = `T.${String(topicIdx + 1).padStart(2, "0")}`;

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm transition-colors hover:border-primary/30">
      <div className="flex items-baseline justify-between gap-3 border-b bg-muted/50 px-[18px] py-[14px]">
        <div className="flex min-w-0 items-center gap-[9px]">
          <span className="shrink-0 rounded-[5px] bg-primary/10 px-[7px] py-[3px] font-mono text-[11px] font-semibold tracking-[0.04em] text-primary dark:bg-algo-teal/15 dark:text-algo-teal">
            {indexLabel}
          </span>
          {title && <h2 className="min-w-0 truncate text-[17px] font-semibold text-foreground">{title}</h2>}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {options.length} option{options.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="p-6 pt-4">
        {body && (
          <ClampedMarkdown lines={5} fadeFrom="from-card" className="mb-5 text-sm text-muted-foreground">
            {body}
          </ClampedMarkdown>
        )}

        {mode === "upcoming" && (
          <div className="flex flex-col divide-y divide-border">
            {options.map((option, optIdx) => (
              <div key={optIdx} className="flex items-center gap-3 py-[11px] first:pt-0 last:pb-0">
                <span className="size-[7px] shrink-0 rounded-full bg-algo-navy-40" />
                <span className="text-[14px] font-medium text-foreground">{option}</span>
              </div>
            ))}
          </div>
        )}

        {mode === "results" && (
          <div className="space-y-3.5">
            {options.map((option, optIdx) => {
              const tally = tallies[optIdx] ?? 0;
              const pct = totalVotes > 0 ? (tally / totalVotes) * 100 : 0;
              const isLeading = totalVotes > 0 && tally === leadingTally;
              const isVoted = votedOptionIdx === optIdx;
              return (
                <div key={optIdx}>
                  <div className="mb-1.5 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={cn("truncate", isLeading ? "font-bold text-foreground" : "font-medium text-foreground")}>
                        {option}
                      </span>
                      {isLeading && <ResultTag tone="lead">LEADING</ResultTag>}
                      {isVoted && <ResultTag tone="you">YOUR VOTE</ResultTag>}
                    </div>
                    <span className="shrink-0 text-[13px] text-muted-foreground">
                      <strong className="text-foreground tabular-nums">{pct.toFixed(1)}%</strong> ·{" "}
                      {tally.toLocaleString()}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted/50">
                    <div
                      className={cn("h-full rounded-full transition-all", isLeading ? "bg-primary" : "bg-algo-navy-40")}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
            <p className="text-xs tabular-nums text-muted-foreground">{totalVotes.toLocaleString()} votes cast</p>
          </div>
        )}

        {mode === "select" && (
          <div className="space-y-2">
            {options.map((option, optIdx) => {
              const isSelected = selectedOption === optIdx;
              return (
                <button
                  key={optIdx}
                  type="button"
                  onClick={() => onSelect?.(optIdx)}
                  className={cn(
                    "flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border p-4 text-left transition-all",
                    isSelected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2",
                        isSelected ? "border-primary" : "border-muted-foreground/40",
                      )}
                    >
                      <span
                        className={cn(
                          "h-2.5 w-2.5 rounded-full bg-primary transition-opacity",
                          isSelected ? "opacity-100" : "opacity-0",
                        )}
                      />
                    </span>
                    <span className="truncate font-medium text-foreground">{option}</span>
                  </div>
                  {isSelected && votingPower != null && (
                    <span className="shrink-0 text-[12.5px] font-semibold text-primary dark:text-algo-teal">
                      All {votingPower.toLocaleString()} votes
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {mode === "advanced" && (
          <div className="space-y-2.5">
            {options.map((option, optIdx) => {
              const alloc = advancedVotes?.[optIdx] ?? 0;
              const allocPct = votingPower && votingPower > 0 ? (alloc / votingPower) * 100 : 0;
              return (
                <div key={optIdx} className="flex items-center gap-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 flex items-center justify-between gap-3">
                      <span className="truncate text-[14px] font-medium text-foreground">{option}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{allocPct.toFixed(0)}%</span>
                    </div>
                    <ProgressBar value={allocPct} tone="sky" height={6} />
                  </div>
                  <div className="flex w-[118px] shrink-0 items-center gap-[7px] rounded-md border border-input bg-background px-[10px] py-[7px]">
                    <input
                      id={`votes-${topicIdx}-${optIdx}`}
                      name={`votes-${topicIdx}-${optIdx}`}
                      type="number"
                      min={0}
                      aria-label={`Votes for ${option}`}
                      className="w-full border-none bg-transparent text-right font-mono text-[13px] tabular-nums text-foreground outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      value={alloc}
                      onChange={(e) => onAdvancedChange?.(optIdx, Number(e.target.value))}
                    />
                    <span className="shrink-0 text-[11px] text-muted-foreground">votes</span>
                  </div>
                </div>
              );
            })}
            {footer}
          </div>
        )}
      </div>
    </section>
  );
}
