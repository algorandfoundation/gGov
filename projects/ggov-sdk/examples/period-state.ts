/**
 * List the state of every live period on a GGovRegistry.
 *
 * Read-only: builds a GGovRegistryReaderSDK (empty signer) and prints registry
 * globals (admin/operator/lastPeriodId + current round) followed by one row per
 * live period summary (periodId, app id, voting window, topic count, ready flag).
 * Deleted periods (summary.appId === 0) are skipped by getAllPeriodSummaries().
 *
 * Usage:
 *   cd projects/ggov-sdk
 *   npx tsx examples/period-state.ts [network|registryAppId]
 *
 * The target defaults to localnet. Pass a network name (localnet|testnet|mainnet)
 * to use the configured registry app id, or pass an explicit numeric app id.
 *
 * Examples:
 *   npx tsx examples/period-state.ts            # localnet (registry app 1002)
 *   npx tsx examples/period-state.ts testnet    # configured testnet registry
 *   npx tsx examples/period-state.ts 764235366  # explicit registry app id
 */
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { GGovRegistryReaderSDK, Network } from "..";

const NETWORKS: Network[] = ["localnet", "testnet", "mainnet"];

/** Format a uint32 unix timestamp (0 = unset) as an ISO string for display. */
function fmtTime(secs: number | bigint): string {
  const n = Number(secs);
  return n === 0 ? "—" : new Date(n * 1000).toISOString();
}

(async () => {
  const arg = process.argv[2] ?? "localnet";
  const algorand = AlgorandClient.fromEnvironment();

  // Either a known network name (use configured app id) or an explicit app id.
  const sdk = NETWORKS.includes(arg as Network)
    ? new GGovRegistryReaderSDK({ algorand, network: arg as Network })
    : new GGovRegistryReaderSDK({ algorand, registryAppId: BigInt(arg) });

  console.log(`Registry app: ${sdk.appId}`);

  const global = await sdk.getGlobalState();
  console.log("Registry state:", {
    admin: global.admin,
    operator: global.operator,
    lastPeriodId: global.lastPeriodId,
    currentRound: global.currentRound,
  });

  const periods = await sdk.getAllPeriodSummaries();
  console.log(`\nLive periods: ${periods.length}`);
  if (periods.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  const status = (s: { votingStart: number; votingEnd: number; ready: boolean }) => {
    if (!s.ready) return "not-ready";
    if (now < Number(s.votingStart)) return "upcoming";
    if (now > Number(s.votingEnd)) return "closed";
    return "open";
  };

  console.table(
    periods.map(({ id, summary }) => ({
      periodId: Number(id),
      appId: Number(summary.appId),
      votingStart: fmtTime(summary.votingStart),
      votingEnd: fmtTime(summary.votingEnd),
      numTopics: Number(summary.numTopics),
      ready: summary.ready,
      status: status(summary),
    })),
  );
})();
