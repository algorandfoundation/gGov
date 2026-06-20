/**
 * List all active delegations stored on a GGovRegistry.
 *
 * Read-only: builds a GGovRegistryReaderSDK (empty signer) and calls
 * getAllDelegations(), which scans the registry's `d`-prefixed delegation boxes
 * and batch-resolves each delegator → delegatee. Prints one row per delegation
 * plus a per-delegatee tally of how many accounts delegate to them.
 *
 * Usage:
 *   cd projects/ggov-sdk
 *   npx tsx examples/delegations-state.ts [network|registryAppId]
 *
 * The target defaults to localnet. Pass a network name (localnet|testnet|mainnet)
 * to use the configured registry app id, or pass an explicit numeric app id.
 *
 * Examples:
 *   npx tsx examples/delegations-state.ts            # localnet (registry app 1002)
 *   npx tsx examples/delegations-state.ts testnet    # configured testnet registry
 *   npx tsx examples/delegations-state.ts 764235366  # explicit registry app id
 */
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { GGovRegistryReaderSDK, Network } from "..";

const NETWORKS: Network[] = ["localnet", "testnet", "mainnet"];

(async () => {
  const arg = process.argv[2] ?? "localnet";
  const algorand = AlgorandClient.fromEnvironment();

  // Either a known network name (use configured app id) or an explicit app id.
  const sdk = NETWORKS.includes(arg as Network)
    ? new GGovRegistryReaderSDK({ algorand, network: arg as Network })
    : new GGovRegistryReaderSDK({ algorand, registryAppId: BigInt(arg) });

  console.log(`Registry app: ${sdk.appId}`);

  const delegations = await sdk.getAllDelegations();
  console.log(`\nActive delegations: ${delegations.size}`);
  if (delegations.size === 0) return;

  console.table(
    [...delegations.entries()].map(([delegator, delegatee]) => ({ delegator, delegatee })),
  );

  // How many accounts delegate to each delegatee.
  const tally = new Map<string, number>();
  for (const delegatee of delegations.values()) {
    tally.set(delegatee, (tally.get(delegatee) ?? 0) + 1);
  }
  console.log(`\nDelegatees: ${tally.size}`);
  console.table(
    [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([delegatee, delegators]) => ({ delegatee, delegators })),
  );
})();
