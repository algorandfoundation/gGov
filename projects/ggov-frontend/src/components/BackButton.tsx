import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Large left-caret back link, sized to sit in line with a page title (`text-2xl`).
 * Negative left margin optically aligns the caret to the page's left edge.
 */
export default function BackButton({ to, className }: { to: string; className?: string }) {
  return (
    <Link
      to={to}
      aria-label="Back"
      className={cn(
        "-ml-2 inline-flex shrink-0 items-center text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
    >
      <ChevronLeft className="size-8" />
    </Link>
  );
}
