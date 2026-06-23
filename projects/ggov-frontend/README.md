# ggov-frontend

The gGov web app — [TanStack Start](https://tanstack.com/start) (SSR) deployed as a
Cloudflare Worker via [`@cloudflare/vite-plugin`](https://developers.cloudflare.com/workers/vite-plugin/).

## Develop

```bash
pnpm dev                 # localnet config
pnpm dev:testnet         # testnet config
pnpm typecheck           # tsr generate + tsc --noEmit
pnpm build               # client + Worker bundles
```

Public client config lives in `.env*` files as `VITE_*` variables (algod server,
network, app IDs). These are bundled into the browser, so **only put public,
non-sensitive values here**.

## Worker secrets (server-only)

Sensitive values must be Cloudflare Worker **secrets**, not `VITE_*` vars — `VITE_*`
is inlined into the client bundle and trivially extractable. Secrets are read only
inside a `createIsomorphicFn().server()` body, which the TanStack Start compiler
strips from the browser build along with its `cloudflare:workers` import
(see [`src/lib/serverReaderSdk.ts`](./src/lib/serverReaderSdk.ts)).

| Secret        | Purpose                                                        |
| ------------- | -------------------------------------------------------------- |
| `ALGOD_TOKEN` | Privileged Algod API token for SSR/loader chain reads on the Worker. Browser reads fall back to the public `VITE_ALGOD_TOKEN`. |

Configure via code (no dashboard):

```bash
# Local dev — copy the template and fill it in (.dev.vars is gitignored):
cp .dev.vars.example .dev.vars

# Production — store the secret with Wrangler:
pnpm wrangler secret put ALGOD_TOKEN
```

To add another secret: declare its type in [`src/types/cloudflare.d.ts`](./src/types/cloudflare.d.ts),
read it inside a `createIsomorphicFn().server()` body, and document it above.

## Deploy

Network config is baked in at **build** time (`vite build --mode <net>` inlines the
`VITE_*` vars from `.env.<net>`), so testnet and mainnet are **separate Workers**,
selected via wrangler environments in [`wrangler.jsonc`](./wrangler.jsonc):

| Network | Worker name             | Command             |
| ------- | ----------------------- | ------------------- |
| testnet | `ggov-frontend-testnet` | `pnpm deploy:testnet` |
| mainnet | `ggov-frontend-mainnet` | `pnpm deploy:mainnet` |

```bash
pnpm deploy:testnet      # typecheck && vite build --mode testnet && wrangler deploy --env testnet
pnpm deploy:mainnet      # typecheck && vite build --mode mainnet && wrangler deploy --env mainnet
pnpm deploy              # localnet build to the top-level worker (rarely used)
```

> **Mainnet is not live yet** — set the real `VITE_GGOV_REGISTRY_APP_ID` in
> [`.env.mainnet`](./.env.mainnet) (and `mainnet.registryAppId` in
> [`../ggov-sdk/src/networkConfig.ts`](../ggov-sdk/src/networkConfig.ts)) before deploying.

Secrets are per-environment — scope the CLI with `--env`:

```bash
pnpm wrangler secret put ALGOD_TOKEN --env testnet
pnpm wrangler secret put ALGOD_TOKEN --env mainnet
```

### Continuous deployment

Merging to `main` deploys the Worker to **testnet** via
[`.github/workflows/frontend-cd.yaml`](../../.github/workflows/frontend-cd.yaml).
**Mainnet** deploys only on demand (no push trigger) via
[`.github/workflows/frontend-cd-mainnet.yaml`](../../.github/workflows/frontend-cd-mainnet.yaml)
— run it from the Actions tab. Configure these secrets on the repo or the matching
environment (`frontend-testnet` / `frontend-mainnet`):

| Secret                  | Purpose                                                              |
| ----------------------- | ------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Wrangler deploy auth (Workers Scripts: Edit).                       |
| `CLOUDFLARE_ACCOUNT_ID` | Target Cloudflare account.                                          |
| `ALGOD_TOKEN`           | Privileged Algod token, uploaded as the Worker secret on each deploy. Optional — SSR reads fall back to the public token if unset. |
