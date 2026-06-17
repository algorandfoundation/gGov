import { useState, useEffect } from 'react'

type Theme = 'light' | 'dark'

const THEME_KEY = 'theme'

function getInitialTheme(): Theme {
  // localStorage access throws in private-mode Safari / when storage is disabled;
  // getInitialTheme runs during useState init, so an uncaught throw would crash render.
  try {
    const stored = localStorage.getItem(THEME_KEY) as Theme | null
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    /* storage unavailable — fall through to the default */
  }
  // DESIGN: light and bright is the default; dark mode is opt-in, never the default.
  return 'light'
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* persisting the preference is best-effort */
    }
  }, [theme])

  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  return { theme, toggle }
}
