/**
 * Storybook mock for `@/hooks/useGGovSDK`.
 *
 * Aliased in `.storybook/main.ts`. The real hook throws without a provider and
 * otherwise constructs network SDK clients — neither of which we want in
 * Storybook. Here `readerSDK`/`escregSDK` are inert Proxy stubs (never actually
 * called, since `@/hooks/queries` is mocked), and `sdk` is non-null only when the
 * mock wallet is connected — exactly what gates the vote form's submit button.
 */
import { type ReactNode } from 'react'
import { useWallet } from './use-wallet-react'

/** Any property access returns a function that resolves to undefined — harmless if ever touched. */
const inertStub = new Proxy(
  {},
  {
    get(_target, prop) {
      // Don't intercept `then` (or any symbol key): otherwise the stub is a
      // thenable and `await inertStub` / `Promise.resolve(inertStub)` would call
      // `.then()` — which never settles — and hang if the stub ever leaks into
      // async code. Every other access is a harmless no-op async function.
      if (prop === 'then' || typeof prop === 'symbol') return undefined
      return () => Promise.resolve(undefined)
    },
  },
)

interface GGovSDKContextValue {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readerSDK: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdk: any | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  escregSDK: any
}

export function useGGovSDK(): GGovSDKContextValue {
  const { activeAddress } = useWallet()
  return {
    readerSDK: inertStub,
    escregSDK: inertStub,
    // A non-null sdk enables write actions (e.g. casting a vote) when connected.
    sdk: activeAddress ? inertStub : null,
  }
}

/** Passthrough so any incidental `GGovSDKProvider` import resolves harmlessly. */
export function GGovSDKProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}
