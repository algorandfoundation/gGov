import { Sun, Moon } from 'lucide-react'
import { useTheme } from '@/hooks/useTheme'
import { Button } from '@/components/ui/button'

/**
 * Light/dark theme toggle. Defaults to a compact icon button; pass `showLabel`
 * for a full-width labelled row (used in the mobile menu).
 */
export default function ThemeToggle({ showLabel = false }: { showLabel?: boolean }) {
  const { theme, toggle } = useTheme()
  const label = theme === 'dark' ? 'Light mode' : 'Dark mode'
  const ariaLabel = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
  const icon = theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />
  if (showLabel) {
    return (
      <Button variant="ghost" className="w-full justify-start gap-2 px-2" onClick={toggle} aria-label={ariaLabel}>
        {icon}
        <span className="text-sm font-normal text-muted-foreground">{label}</span>
      </Button>
    )
  }
  return (
    <Button variant="ghost" size="icon" className="size-8" onClick={toggle} aria-label={ariaLabel} title={label}>
      {icon}
    </Button>
  )
}
