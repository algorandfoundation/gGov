import { Link } from "react-router-dom";
import { useCommittees } from "@/hooks/queries";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

export default function Committees() {
  const { data: committees = [], isLoading } = useCommittees();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Committees</h1>
      <p className="text-sm text-muted-foreground">Voting power is determined by block production.</p>
      <p className="text-sm text-muted-foreground">
        Each committee tracks the blocks produced by its members over a range of rounds, and each block produced counts as one vote.
      </p>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : committees.length === 0 ? (
        <p className="text-muted-foreground">No committees found.</p>
      ) : (
        <Table className="max-w-lg">
          <TableHeader>
            <TableRow>
              <TableHead>Rounds</TableHead>
              <TableHead className="text-right">Members</TableHead>
              <TableHead className="text-right">Total votes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {committees.map((c) => (
              <TableRow key={c.idBase64Url}>
                <TableCell>
                  <Link to={`/committees/${c.idBase64Url}`} className="text-primary hover:underline">
                    {c.periodStart} — {c.periodEnd}
                  </Link>
                </TableCell>
                <TableCell className="text-right tabular-nums">{c.totalMembers}</TableCell>
                <TableCell className="text-right tabular-nums">{c.totalVotes}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
