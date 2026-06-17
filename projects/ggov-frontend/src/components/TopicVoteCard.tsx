import * as React from "react";
import { ClampedMarkdown } from "@/components/ui/clamped-markdown";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type TopicVoteMode = "upcoming" | "results" | "select" | "advanced";

interface TopicVoteCardProps {
  /** Short badge shown in the header band, e.g. "G12.1". */
  badge: string;
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
  /** Footer node, e.g. an allocation summary in `advanced` mode. */
  footer?: React.ReactNode;
  topicIdx: number;
}

/** Filled progress bar matching the stitch tally style. */
function OptionBar({ pct, emphasize }: { pct: number; emphasize?: boolean }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full transition-all", emphasize ? "bg-primary" : "bg-muted-foreground/50")}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/**
 * Stitch-style voting topic: a card with a header band (badge + total votes)
 * and option rows rendered as bordered cards with live tallies. Supports
 * read-only results, single-select voting, and advanced manual allocation.
 */
export default function TopicVoteCard({
  badge,
  title,
  body,
  options,
  tallies,
  mode,
  selectedOption = -1,
  onSelect,
  advancedVotes,
  onAdvancedChange,
  footer,
  topicIdx,
}: TopicVoteCardProps) {
  const totalVotes = tallies.reduce((a, b) => a + b, 0);

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm transition-colors hover:border-primary/30">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/50 px-4 py-3">
        <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">{badge}</span>
        {mode !== "upcoming" && (
          <span className="text-xs tabular-nums text-muted-foreground">{totalVotes.toLocaleString()} votes</span>
        )}
      </div>

      <div className="p-6">
        {title && <h2 className="mb-2 text-lg font-semibold text-foreground">{title}</h2>}
        {body && <ClampedMarkdown fadeFrom="from-card" className="mb-5 text-sm text-muted-foreground">{body}</ClampedMarkdown>}

        {mode === "upcoming" ? (
          <p className="text-sm text-muted-foreground">Options: {options.join(", ")}</p>
        ) : (
          <div className="space-y-3">
            {options.map((option, optIdx) => {
              const tally = tallies[optIdx] ?? 0;
              const pct = totalVotes > 0 ? (tally / totalVotes) * 100 : 0;
              const isSelected = selectedOption === optIdx;

              const inner = (
                <>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      {mode === "select" && (
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
                      )}
                      <span className="truncate font-medium text-foreground">{option}</span>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 font-bold tabular-nums",
                        isSelected ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      {pct.toFixed(1)}%
                    </span>
                  </div>
                  <OptionBar pct={pct} emphasize={isSelected || pct >= 50} />
                  <div className="mt-1 flex justify-end">
                    <span className="text-xs tabular-nums text-muted-foreground">{tally.toLocaleString()} votes</span>
                  </div>
                  {mode === "advanced" && (
                    <div className="mt-2 flex items-center gap-2">
                      <Label htmlFor={`votes-${topicIdx}-${optIdx}`} className="w-20 text-xs">
                        Your votes:
                      </Label>
                      <Input
                        id={`votes-${topicIdx}-${optIdx}`}
                        name={`votes-${topicIdx}-${optIdx}`}
                        type="number"
                        min={0}
                        className="h-7 w-24 text-xs tabular-nums"
                        value={advancedVotes?.[optIdx] ?? 0}
                        onChange={(e) => onAdvancedChange?.(optIdx, Number(e.target.value))}
                      />
                    </div>
                  )}
                </>
              );

              const boxClass = cn(
                "rounded-xl border p-4 transition-all",
                isSelected ? "border-primary bg-primary/5" : "border-border",
              );

              return mode === "select" ? (
                <button
                  key={optIdx}
                  type="button"
                  onClick={() => onSelect?.(optIdx)}
                  className={cn(boxClass, "block w-full text-left hover:bg-muted/50")}
                >
                  {inner}
                </button>
              ) : (
                <div key={optIdx} className={boxClass}>
                  {inner}
                </div>
              );
            })}
          </div>
        )}

        {footer}
      </div>
    </section>
  );
}
