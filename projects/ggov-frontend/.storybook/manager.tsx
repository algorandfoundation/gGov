import React from 'react'
import { addons, types, useGlobals } from 'storybook/manager-api'
import { IconButton } from 'storybook/internal/components'

/**
 * Custom toolbar tools for the two-option globals (`theme`, `auth`). Built-in
 * `globalTypes` toolbars only render as a dropdown; these render a single button
 * that flips the global on click. Their `globalTypes.toolbar` config is removed in
 * `preview.tsx` so there's exactly one control each. (`periodPhase` has three
 * options, so it stays a dropdown there.)
 */
const ADDON_ID = 'ggov/toolbar-toggles'

function ThemeToggle() {
  const [globals, updateGlobals] = useGlobals()
  const dark = globals.theme === 'dark'
  return (
    <IconButton
      key="theme"
      active={dark}
      title="Toggle light / dark theme"
      onClick={() => updateGlobals({ theme: dark ? 'light' : 'dark' })}
    >
      <span style={{ fontSize: 13 }}>{dark ? '🌙 Dark' : '🌞 Light'}</span>
    </IconButton>
  )
}

function AuthToggle() {
  const [globals, updateGlobals] = useGlobals()
  const connected = globals.auth !== 'disconnected'
  return (
    <IconButton
      key="auth"
      active={connected}
      title="Toggle wallet connected / disconnected"
      onClick={() => updateGlobals({ auth: connected ? 'disconnected' : 'connected' })}
    >
      <span style={{ fontSize: 13 }}>{connected ? '🟢 Connected' : '⚪ Disconnected'}</span>
    </IconButton>
  )
}

addons.register(ADDON_ID, () => {
  // Show on the main canvas (story + docs), not on custom addon tabs.
  const match = ({ tabId }: { tabId?: string }) => !tabId

  addons.add(`${ADDON_ID}/theme`, {
    type: types.TOOL,
    title: 'Theme',
    match,
    render: () => <ThemeToggle />,
  })
  addons.add(`${ADDON_ID}/auth`, {
    type: types.TOOL,
    title: 'Auth',
    match,
    render: () => <AuthToggle />,
  })
})
