import { Avatar, avatarTone, type AvatarTone } from "@/components/ui/avatar"
import { useAddressNfd } from "@/hooks/use-nfd"

interface AccountAvatarProps {
  /** Algorand address the avatar represents. */
  address: string
  /** Display name override (e.g. "You" or a wallet-local account name); falls back to the NFD name, then the address. */
  name?: string | null
  /** Pixel diameter. */
  size?: number
  /** Background tone; defaults to a deterministic tint derived from the address. */
  tone?: AvatarTone
  className?: string
}

/**
 * Account avatar: resolves the address's NFD profile and renders its avatar image when
 * one exists, falling back to the deterministic initial-on-tint. The single place that
 * wires NFD avatars into the presentational {@link Avatar}.
 */
export function AccountAvatar({ address, name, size, tone, className }: AccountAvatarProps) {
  const { data: nfd } = useAddressNfd(address)
  return (
    <Avatar
      name={name ?? nfd?.name ?? address}
      src={nfd?.avatar}
      tone={tone ?? avatarTone(address)}
      size={size}
      className={className}
    />
  )
}
