export interface AlgodConfig {
  server: string
  port: string | number
  token: string
  network: string
}

export interface KmdConfig {
  server: string
  port: string | number
  token: string
  wallet: string
  password: string
}

// AlgoKit LocalNet defaults, applied when the corresponding VITE_* vars are
// unset (a fresh checkout / worktree with no `.env`). `npm run dev` then targets
// LocalNet (algod :4001, kmd :4002) out of the box instead of throwing. Override
// per-network with the VITE_ALGOD_* / VITE_KMD_* vars (see .env.example) or by
// building with `--mode testnet|mainnet`.
const LOCALNET_TOKEN = 'a'.repeat(64)

const LOCALNET_ALGOD: AlgodConfig = {
  server: 'http://localhost',
  port: 4001,
  token: LOCALNET_TOKEN,
  network: 'localnet',
}

const LOCALNET_KMD: KmdConfig = {
  server: 'http://localhost',
  port: 4002,
  token: LOCALNET_TOKEN,
  wallet: 'unencrypted-default-wallet',
  password: '',
}

export function getAlgodConfigFromViteEnvironment(): AlgodConfig {
  return {
    server: import.meta.env.VITE_ALGOD_SERVER || LOCALNET_ALGOD.server,
    port: import.meta.env.VITE_ALGOD_PORT || LOCALNET_ALGOD.port,
    // `??` not `||`: testnet/mainnet use an empty token (public Nodely nodes),
    // and that empty string must survive rather than fall back to the LocalNet token.
    token: import.meta.env.VITE_ALGOD_TOKEN ?? LOCALNET_ALGOD.token,
    network: import.meta.env.VITE_ALGOD_NETWORK || LOCALNET_ALGOD.network,
  }
}

export function getKmdConfigFromViteEnvironment(): KmdConfig {
  return {
    server: import.meta.env.VITE_KMD_SERVER || LOCALNET_KMD.server,
    port: import.meta.env.VITE_KMD_PORT || LOCALNET_KMD.port,
    token: import.meta.env.VITE_KMD_TOKEN ?? LOCALNET_KMD.token,
    wallet: import.meta.env.VITE_KMD_WALLET || LOCALNET_KMD.wallet,
    password: import.meta.env.VITE_KMD_PASSWORD ?? LOCALNET_KMD.password,
  }
}
