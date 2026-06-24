import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

export type AvatarTone = 'teal' | 'aqua' | 'plum' | 'navy'

interface AvatarProps {
  /** Display name or address used to derive the initial. */
  name?: string | null
  /** Avatar image URL (e.g. an NFD avatar). Falls back to the initial-on-tint when absent or it fails to load. */
  src?: string | null
  /** Pixel diameter. */
  size?: number
  /** Background tone, shown as the tint behind the initial (or while an image loads). */
  tone?: AvatarTone
  className?: string
}

/** Tone → background + readable on-color. Mirrors the design-system avatar tints. */
const TONE: Record<AvatarTone, string> = {
  teal: 'bg-algo-teal text-[#001324]',
  aqua: 'bg-[#45D5D1] text-[#001324]',
  plum: 'bg-[#B07CC6] text-[#2A0E3F]',
  navy: 'bg-[#334250] text-white',
}

/**
 * Avatar (design-system "Avatar"). Renders `src` as a rounded image when supplied
 * (e.g. an NFD avatar); otherwise — or if the image fails to load — falls back to a
 * deterministic initial-on-tint that distinguishes accounts in lists.
 */
export function Avatar({ name, src, size = 40, tone = 'teal', className }: AvatarProps) {
  const [failed, setFailed] = useState(false)
  // Retry the image whenever the source changes (e.g. NFD resolves after first render).
  useEffect(() => setFailed(false), [src])

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        loading="lazy"
        onError={() => setFailed(true)}
        className={cn('inline-block shrink-0 rounded-full object-cover', TONE[tone], className)}
        style={{ width: size, height: size }}
      />
    )
  }

  const initial = (name?.trim()?.[0] ?? '?').toUpperCase()
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-display font-bold',
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
  const tones: AvatarTone[] = ['teal', 'aqua', 'plum', 'navy']
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return tones[h % tones.length]
}
