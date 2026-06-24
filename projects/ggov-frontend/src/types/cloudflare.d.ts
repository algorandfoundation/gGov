// Ambient type for the Cloudflare Worker runtime env, accessed server-side only
// via `import('cloudflare:workers')`. Declared here (inside `src`, the sole
// tsconfig `include`) so typecheck passes without the gitignored, root-level
// worker-configuration.d.ts that `wrangler types` would emit. Keep the fields in
// sync with the Worker's secrets/vars.
declare module 'cloudflare:workers' {
  export const env: {
    /**
     * Privileged Algod API token — a Worker secret (set via `wrangler secret put
     * ALGOD_TOKEN` / `.dev.vars`). Deliberately NOT prefixed `VITE_` and only read
     * inside a `createIsomorphicFn().server()` body (serverReaderSdk.ts), which the
     * TanStack Start compiler strips from the client bundle — so it can never reach
     * the browser.
     */
    ALGOD_TOKEN?: string
    /**
     * Algod node URL for SSR/loader chain reads on the Worker. A public `var`
     * (set per-environment in wrangler.jsonc, or in `.dev.vars` for local dev),
     * NOT a secret. Overrides the build-time VITE_ALGOD_SERVER for server reads
     * so a deployed Worker can be repointed without a rebuild; unset → the SSR
     * reader falls back to the inlined Vite config.
     */
    ALGOD_SERVER?: string
    [key: string]: unknown
  }
}
