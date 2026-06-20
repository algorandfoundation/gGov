import { cn } from "@/lib/utils"

interface AvatarProps {
  /** Display name or address used to derive the initial. */
  name?: string | null
  /** Pixel diameter. */
  size?: number
  className?: string
}

/**
 * Simple initial-on-tint avatar (design-system "Avatar"). The gGov design uses a
 * teal ground; we keep a single tone since accounts have no uploaded image.
 */
export function Avatar({ name, size = 40, className }: AvatarProps) {
  const initial = (name?.trim()?.[0] ?? "?").toUpperCase()
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-algo-teal font-display font-bold text-[#001324]",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {initial}
    </span>
  )
}
