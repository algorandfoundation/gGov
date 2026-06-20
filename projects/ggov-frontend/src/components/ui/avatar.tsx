import { cn } from "@/lib/utils"

export type AvatarTone = "teal" | "aqua" | "plum" | "navy"

interface AvatarProps {
  /** Display name or address used to derive the initial. */
  name?: string | null
  /** Pixel diameter. */
  size?: number
  /** Background tone. Accounts have no uploaded image, so the tone just varies the tint. */
  tone?: AvatarTone
  className?: string
}

/** Tone → background + readable on-color. Mirrors the design-system avatar tints. */
const TONE: Record<AvatarTone, string> = {
  teal: "bg-algo-teal text-[#001324]",
  aqua: "bg-[#45D5D1] text-[#001324]",
  plum: "bg-[#B07CC6] text-[#2A0E3F]",
  navy: "bg-[#334250] text-white",
}

/**
 * Simple initial-on-tint avatar (design-system "Avatar"). Accounts have no
 * uploaded image, so a deterministic tone tint distinguishes them in lists.
 */
export function Avatar({ name, size = 40, tone = "teal", className }: AvatarProps) {
  const initial = (name?.trim()?.[0] ?? "?").toUpperCase()
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-display font-bold",
        TONE[tone],
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {initial}
    </span>
  )
}

/** Deterministic tone from an address/name, so the same account keeps its tint. */
export function avatarTone(seed: string): AvatarTone {
  const tones: AvatarTone[] = ["teal", "aqua", "plum", "navy"]
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return tones[h % tones.length]
}
