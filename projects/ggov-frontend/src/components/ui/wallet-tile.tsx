import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * One wallet option in the connect-wallet picker grid: provider logo over its name.
 * `connecting` dims the logo and overlays a blue spinner (the per-tile "Connecting…"
 * state). Falls back to an initial-on-teal tile when the wallet has no `icon`.
 */
export function WalletTile({
  name,
  icon,
  connecting = false,
  disabled = false,
  onClick,
}: {
  name: string
  icon?: string
  connecting?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || connecting}
      aria-busy={connecting}
      className={cn(
        "flex flex-col items-center gap-3 rounded-md border px-3 py-5 transition-colors",
        "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 disabled:cursor-default",
        connecting
          ? "border-primary bg-primary/10"
          : "border-border hover:border-primary hover:bg-accent/50",
      )}
    >
      <span className="relative flex size-12 items-center justify-center">
        {icon ? (
          <img
            src={icon}
            alt=""
            aria-hidden
            className={cn("size-12 rounded-[13px] object-cover", connecting && "opacity-40")}
          />
        ) : (
          <span
            className={cn(
              "bg-algo-teal flex size-12 items-center justify-center rounded-[13px] font-display text-xl font-bold text-[#001324]",
              connecting && "opacity-40",
            )}
          >
            {name.charAt(0)}
          </span>
        )}
        {connecting && (
          <span className="text-primary absolute inset-0 flex items-center justify-center">
            <Loader2 className="size-6 animate-spin" />
          </span>
        )}
      </span>
      <span className={cn("text-sm font-semibold", connecting ? "text-primary" : "text-foreground")}>
        {connecting ? "Connecting…" : name}
      </span>
    </button>
  )
}
