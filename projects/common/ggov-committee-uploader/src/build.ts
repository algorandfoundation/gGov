/**
 * Build gGov committee files from the published xGov committees.
 *
 * For each period in the xGov committee index, the gGov committee file takes
 * its members from the xGov candidate committee and its metadata from the xGov
 * committee file, with `registryId` set to a placeholder (default `1`).
 *
 * Output is written to ./committees/<periodStart>-<periodEnd>.json
 *
 * Usage:
 *   pnpm build                       # all periods in the index
 *   pnpm build 59000000-62000000     # one or more periods (from-to)
 *   pnpm build 62000000              # ...or by toRound
 *
 * Env:
 *   REGISTRY_ID   placeholder registry id (default 1)
 *   BASE_URL      xGov committee host (default https://xgov-committees.algorand.tech)
 *   NETWORK_PATH  network path segment (default mainnet-v1.0-...)
 */

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DEFAULT_REGISTRY_ID,
  buildGGovCommitteeForPeriod,
  committeeFileName,
  fetchCommitteeIndex,
  type IndexCommittee,
  type XGovSourceOptions,
} from "./xgov";

// The ggov-sdk dist is ESM-syntax but ships without "type": "module", so it
// must be loaded via require() rather than a static import.
const require = createRequire(import.meta.url);
const { calculateCommitteeId } = require("../../../ggov-sdk/dist/index.js");

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "committees");

function toBase64Id(file: unknown): string {
  const id: Uint8Array = calculateCommitteeId(JSON.stringify(file));
  return Buffer.from(id).toString("base64");
}

/** Match a CLI selector ("from-to" or "toRound") against an index entry. */
function matchesSelector(c: IndexCommittee, selector: string): boolean {
  return selector === `${c.fromRound}-${c.toRound}` || selector === String(c.toRound);
}

async function main() {
  const selectors = process.argv.slice(2);
  const registryId = process.env.REGISTRY_ID ? Number(process.env.REGISTRY_ID) : DEFAULT_REGISTRY_ID;
  const source: XGovSourceOptions = {
    baseUrl: process.env.BASE_URL,
    networkPath: process.env.NETWORK_PATH,
  };

  const index = await fetchCommitteeIndex(source);
  const selected = selectors.length
    ? index.filter((c) => selectors.some((s) => matchesSelector(c, s)))
    : index;

  if (!selected.length) {
    throw new Error(`No committees matched ${JSON.stringify(selectors)} (available: ${index.map((c) => `${c.fromRound}-${c.toRound}`).join(", ")})`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Building ${selected.length} gGov committee file(s) with registryId=${registryId}\n`);

  for (const committee of selected) {
    const file = await buildGGovCommitteeForPeriod(committee, registryId, source);
    const name = committeeFileName(file);
    writeFileSync(join(OUT_DIR, name), JSON.stringify(file, null, 2) + "\n");
    console.log(
      `${name}  members=${file.totalMembers}  votes=${file.totalVotes}  committeeId=${toBase64Id(file)}`,
    );
  }

  console.log(`\nWrote ${selected.length} file(s) to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
