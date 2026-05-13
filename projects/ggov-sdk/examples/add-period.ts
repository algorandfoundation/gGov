/**
 * Smoke test for the ggov-sdk's addPeriod factory flow on localnet.
 *
 * Usage:
 *   cd projects/ggov-sdk
 *   npx tsx examples/add-period.ts ../common/committee-files/2048.json
 *
 * Steps:
 *   1. GGovSDK.createRegistry() — deploys registry, seeds MBR, uploads period approval
 *      bytecode, sets the operator (= deployer for convenience) in one call
 *   2. uploadCommitteeFile (committee must be complete before addPeriod)
 *   3. addPeriod (creates a child GGovPeriod app via inner txn)
 *   4. addTopic
 *   5. getPeriod (reads from the per-period app)
 *   6. getPeriodSummary (reads from the registry)
 */
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { readFileSync } from "fs";
import { GGovSDK } from "..";

(async () => {
  const file = JSON.parse(readFileSync(process.argv[2], "utf-8"));

  const algorand = AlgorandClient.defaultLocalNet();
  const deployer = await algorand.account.fromEnvironment("DEPLOYER");

  // 1. Deploy fresh GGovRegistry + seed MBR + upload period approval bytecode + setOperator.
  const { sdk, appClient } = await GGovSDK.createRegistry({
    algorand,
    deployer: { sender: deployer.addr, signer: deployer.signer },
    operatorAccount: deployer.addr.toString(),
  });
  console.log("Registry app:", appClient.appId, "operator set to deployer");

  // 3. uploadCommitteeFile
  const committeeId = await sdk.uploadCommitteeFile(file);
  console.log("Committee uploaded:", Buffer.from(committeeId).toString("base64"));

  // 4. addPeriod
  const now = BigInt(Math.floor(Date.now() / 1000));
  const periodId = await sdk.addPeriod({
    committeeId,
    votingStart: now + 60n,
    votingEnd: now + 3600n,
  });
  console.log("Period created, periodId:", periodId);

  // 5. addTopic
  const topicIndex = await sdk.addTopic({
    periodId,
    options: ["Yes", "No", "Abstain"],
  });
  console.log("Topic added, index:", topicIndex);

  // 6. getPeriod (reads from per-period app)
  const period = await sdk.getPeriod(periodId);
  console.log("Period detail:", {
    votingStart: period.votingStart,
    votingEnd: period.votingEnd,
    topics: period.topics.length,
  });

  // 7. getPeriodSummary (reads from registry)
  const { return: summary } = await sdk.registry.readClient.send.getPeriodSummary({
    args: { periodId },
  });
  console.log("Registry summary:", {
    appId: summary!.appId,
    votingStart: summary!.votingStart,
    votingEnd: summary!.votingEnd,
    numTopics: summary!.numTopics,
  });
})();
