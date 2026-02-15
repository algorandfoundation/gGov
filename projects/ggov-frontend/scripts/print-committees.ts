/**
 * Print all committee metadata from the GGov SDK.
 *
 * Usage:
 *   npx tsx scripts/print-committees.ts
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AlgorandClient } = require("@algorandfoundation/algokit-utils");
const { GGovReaderSDK } = require("../../ggov-sdk/dist/sdkReader.js");

const KMD_TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const APP_ID = Number(process.env.VITE_GGOV_APP_ID || 1002);

const LOCALNET_CONFIG = {
  algodConfig: { server: "http://localhost", port: 4001, token: KMD_TOKEN },
  indexerConfig: { server: "http://localhost", port: 8980, token: KMD_TOKEN },
  kmdConfig: { server: "http://localhost", port: 4002, token: KMD_TOKEN },
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b: number) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function main() {
  const algorand = AlgorandClient.fromConfig(LOCALNET_CONFIG);

  const sdk = new GGovReaderSDK({
    algorand,
    ggovAppId: APP_ID,
  });

  console.log(`GGov App ID: ${APP_ID}`);

  // Get creator and operator from app info / global state
  const appInfo = await algorand.app.getById(BigInt(APP_ID));
  const creator = appInfo.creator?.toString() ?? "(unknown)";
  const operator = await sdk.ggovReadClient.state.global.operator() ?? "(not set)";
  console.log(`Creator:     ${creator}`);
  console.log(`Operator:    ${operator}\n`);

  // Get all committee IDs
  const committeeIds: Uint8Array[] = await sdk.getCommitteeIds();
  console.log(`Found ${committeeIds.length} committee(s)\n`);

  for (const committeeId of committeeIds) {
    const hex = toHex(committeeId);
    console.log(`${"=".repeat(70)}`);
    console.log(`Committee: ${hex}`);
    console.log(`${"=".repeat(70)}`);

    // Get metadata
    const metadata = await sdk.getCommitteeMetadata(committeeId);
    if (metadata) {
      console.log(`  Numeric ID:      ${metadata.numericId}`);
      console.log(`  Period Start:    ${metadata.periodStart}`);
      console.log(`  Period End:      ${metadata.periodEnd}`);
      console.log(`  Total Members:   ${metadata.totalMembers}`);
      console.log(`  Total Votes:     ${metadata.totalVotes}`);
      console.log(`  Ingested Votes:  ${metadata.ingestedVotes}`);
      console.log(`  Registry ID:     ${metadata.xGovRegistryId}`);
    } else {
      console.log("  (no metadata)");
    }

    // Get xGov members
    const xGovs = await sdk.getCommitteeXGovs(committeeId);
    console.log(`\n  Members (${xGovs.length}):`);
    for (const xGov of xGovs) {
      const addr = typeof xGov.account === "string" ? xGov.account : xGov.account.toString();
      console.log(`    ${addr}  votes: ${xGov.votes}`);
    }

    console.log();
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
