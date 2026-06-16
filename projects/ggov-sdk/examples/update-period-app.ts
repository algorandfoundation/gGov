/**
 * Update a deployed period's on-chain application code to the GGovPeriod build bundled
 * with this `ggov-sdk` version. The period write client recompiles the approval/clear
 * programs from its embedded app spec, so `updatePeriodApp` replaces the running code
 * with the version exported here. This is admin-only — the contract's updateApplication
 * baremethod inner-calls registry.verifyAdmin, so DEPLOYER must be the registry admin.
 *
 * The target period is located by its body title (e.g. "Entertainment") rather than a
 * raw periodId, since titles are what operators recognise.
 *
 * Usage:
 *   cd projects/ggov-sdk
 *   # defaults: registry app 1004, title "Entertainment"
 *   npx tsx examples/update-period-app.ts
 *   # or pass them explicitly:
 *   npx tsx examples/update-period-app.ts <registryAppId> "<periodTitle>"
 */
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { GGovSDK } from "..";

(async () => {
  const registryAppId = BigInt(process.argv[2] ?? 1004);
  const title = process.argv[3] ?? "Entertainment";

  const algorand = AlgorandClient.fromEnvironment();
  const deployer = await algorand.account.fromEnvironment("DEPLOYER");

  // Writer-enabled SDK bound to the existing registry. Writer must be the registry admin.
  const sdk = new GGovSDK({
    algorand,
    registryAppId: registryAppId,
    writerAccount: { sender: deployer.addr, signer: deployer.signer },
  });
  console.log(`Connected to registry app ${registryAppId} as ${deployer.addr}`);

  // Locate the period whose body title matches. getAllPeriodSummaries gives every live
  // periodId; getPeriodBody reads the title from each per-period app.
  const summaries = await sdk.getAllPeriodSummaries();
  if (summaries.length === 0) throw new Error("Registry has no periods");

  const bodies = await Promise.all(
    summaries.map(async ({ id }) => ({ id, body: await sdk.getPeriodBody(id) })),
  );
  const match = bodies.find(({ body }) => body?.title === title);
  if (!match) {
    const available = bodies.map((b) => b.body?.title ?? "(untitled)").join(", ");
    throw new Error(`No period titled "${title}". Available: ${available}`);
  }

  const periodId = match.id;
  const appIdBefore = await sdk.getPeriodAppId(periodId);
  console.log(`Found "${title}" → periodId ${periodId}, period app ${appIdBefore}`);

  // Replace the period app's program with this SDK build's GGovPeriod code.
  await sdk.updatePeriodApp({ periodId });
  console.log(`Updated period app ${appIdBefore} (periodId ${periodId}) to the current GGovPeriod build`);
})();
