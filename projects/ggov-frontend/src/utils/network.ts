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

export function getAlgodConfigFromViteEnvironment(): AlgodConfig {
  if (!import.meta.env.VITE_ALGOD_SERVER) {
    throw new Error('VITE_ALGOD_SERVER environment variable is not set')
  }
  return {
    server: import.meta.env.VITE_ALGOD_SERVER,
    port: import.meta.env.VITE_ALGOD_PORT,
    token: import.meta.env.VITE_ALGOD_TOKEN,
    network: import.meta.env.VITE_ALGOD_NETWORK,
  }
}

export function getKmdConfigFromViteEnvironment(): KmdConfig {
  if (!import.meta.env.VITE_KMD_SERVER) {
    throw new Error('VITE_KMD_SERVER environment variable is not set')
  }
  return {
    server: import.meta.env.VITE_KMD_SERVER,
    port: import.meta.env.VITE_KMD_PORT,
    token: import.meta.env.VITE_KMD_TOKEN,
    wallet: import.meta.env.VITE_KMD_WALLET,
    password: import.meta.env.VITE_KMD_PASSWORD,
  }
}
