/**
 * Delete a GGov contract — either the GGovRegistry app itself or one of its deployed
 * GGovPeriod apps. Both deletions are admin-only: the registry's `deleteApplication` checks
 * the caller is the admin directly, and a period's `deleteApplication` inner-calls
 * registry.verifyAdmin, so the DEPLOYER environment account must be the registry admin.
 *
 * SAFETY GUARD: deleting an app closes its account and sweeps the residual ALGO to the
 * deleting sender. To avoid accidentally tearing down an app that still escrows meaningful
 * funds, this script refuses to delete when the app's *available* balance (balance minus the
 * minimum-balance requirement) exceeds 10 ALGO. Withdraw first (see withdraw-algo.ts), then
 * re-run.
 *
 * The target contract is identified by its on-chain application id. The script locates the
 * registry deployed by DEPLOYER, then:
 *   - if <appId> is the registry app  → registry.deleteApplication
 *   - if <appId> is one of its periods → deletePeriodApp (resolved appId → periodId)
 *
 * Usage (localnet):
 *   cd projects/ggov-sdk
 *   npx tsx examples/delete-app.ts <appId>
 */
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { algo } from "@algorandfoundation/algokit-utils";
import { getApplicationAddress } from "algosdk";
import { GGovSDK, GGovRegistryFactory } from "..";

/** Refuse to delete an app whose available balance is over this threshold. */
const MAX_AVAILABLE_BALANCE = algo(10).microAlgo;

(async () => {
  const appIdArg = process.argv[2];
  if (!appIdArg) {
    console.error("Usage: npx tsx examples/delete-app.ts <appId>");
    process.exit(1);
  }
  const targetAppId = BigInt(appIdArg);

  const algorand = AlgorandClient.fromEnvironment();
  const deployer = await algorand.account.fromEnvironment("DEPLOYER");

  // Locate the GGovRegistry deployed by DEPLOYER — needed even for period deletions,
  // since a period's deleteApplication routes its admin check through the registry.
  const factory = algorand.client.getTypedAppFactory(GGovRegistryFactory, {
    defaultSender: deployer.addr,
  });
  const { appId: registryAppId } = await factory.getAppClientByCreatorAndName({
    creatorAddress: deployer.addr,
    appName: "GGovRegistry",
  });

  const sdk = new GGovSDK({
    algorand,
    registryAppId: registryAppId,
    writerAccount: { sender: deployer.addr, signer: deployer.signer },
  });
  console.log(`Connected to registry app ${registryAppId} as ${deployer.addr}`);

  // Guard: refuse if the app still escrows more than the threshold of available ALGO.
  const appAddress = getApplicationAddress(targetAppId);
  const info = await algorand.account.getInformation(appAddress);
  const available = info.balance.microAlgo - info.minBalance.microAlgo;
  console.log(
    `App ${targetAppId} (${appAddress}): balance ${info.balance.algo} ALGO, ` +
      `min-balance ${info.minBalance.algo} ALGO, available ${Number(available) / 1e6} ALGO`,
  );
  if (available > MAX_AVAILABLE_BALANCE) {
    console.error(
      `Refusing to delete: available balance ${Number(available) / 1e6} ALGO exceeds the ` +
        `${Number(MAX_AVAILABLE_BALANCE) / 1e6} ALGO limit. Withdraw the surplus first ` +
        `(examples/withdraw-algo.ts), then re-run.`,
    );
    process.exit(1);
  }

  if (targetAppId === registryAppId) {
    await sdk.registry.deleteApplication({});
    console.log(`Deleted registry app ${registryAppId}`);
    return;
  }

  // Not the registry — must be one of its period apps. Map appId → periodId.
  const summaries = await sdk.getAllPeriodSummaries();
  const match = summaries.find(({ summary }) => BigInt(summary.appId) === targetAppId);
  if (!match) {
    const known = summaries.map(({ id, summary }) => `${summary.appId} (periodId ${id})`).join(", ");
    throw new Error(
      `App ${targetAppId} is neither the registry (${registryAppId}) nor a known period app. ` +
        `Known period apps: ${known || "(none)"}`,
    );
  }

  await sdk.deletePeriodApp({ periodId: match.id });
  console.log(`Deleted period app ${targetAppId} (periodId ${match.id})`);
})();
