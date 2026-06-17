import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Users, ListChecks, Vote, CalendarArrowUp } from "lucide-react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import PeriodStatusBadge from "@/components/PeriodStatusBadge";
import { formatTimestamp } from "@/utils/time";

interface PeriodInfoCardProps {
  /** Voting window start, unix seconds. */
  votingStart: number;
  /** Voting window end, unix seconds. */
  votingEnd: number;
  /** Number of topics in the period. */
  topics: number;
  /** Total voting power exercised so far across the period. */
  votesCast: number;
  /** Committee size — number of governors eligible to vote. Undefined while loading. */
  eligibleGovernors?: number;
  /** Link to the period's committee; makes the Eligible Governors stat a link. */
  committeeHref?: string;
  /** Optional content rendered in the card footer (e.g. an explorer link). */
  footer?: ReactNode;
  className?: string;
}

/** Period-level metadata and stats shown in the voting sidebar. */
export default function PeriodInfoCard({
  votingStart,
  votingEnd,
  topics,
  votesCast,
  eligibleGovernors,
  committeeHref,
  footer,
  className,
}: PeriodInfoCardProps) {
  const stats = [
    { label: "Topics", value: topics, icon: ListChecks },
    { label: "Eligible Governors", value: eligibleGovernors, icon: Users, href: committeeHref },
    { label: "Votes Cast", value: votesCast, icon: Vote },
  ];

  return (
    <Card className={className}>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">Period Information</CardTitle>
        <PeriodStatusBadge votingStart={votingStart} votingEnd={votingEnd} />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-muted-foreground">
              <CalendarArrowUp className="size-4" />
              <span>Starts</span>
            </div>
            <span className="tabular-nums">{formatTimestamp(votingStart)}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="size-4" aria-hidden />
              <span>Ends</span>
            </div>
            <span className="tabular-nums">{formatTimestamp(votingEnd)}</span>
          </div>
        </div>

        <div className="divide-y border-t">
          {stats.map(({ label, value, icon: Icon, href }) => (
            <div key={label} className="flex items-center justify-between py-3 last:pb-0">
              {href ? (
                <Link to={href} className="flex items-center gap-2 text-sm text-primary hover:underline">
                  <Icon className="size-4" />
                  <span>{label}</span>
                </Link>
              ) : (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Icon className="size-4" />
                  <span>{label}</span>
                </div>
              )}
              <span className="text-base font-semibold tabular-nums">{value?.toLocaleString() ?? "—"}</span>
            </div>
          ))}
        </div>
      </CardContent>
      {footer && <CardFooter className="justify-end border-t pt-4">{footer}</CardFooter>}
    </Card>
  );
}
