import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { GGovRegistrySDK, GGovRegistryFactory } from "..";
import { readFileSync } from "fs";

(async () => {
  const file = JSON.parse(readFileSync(process.argv[2], "utf-8"));

  const algorand = AlgorandClient.defaultLocalNet();
  const deployer = await algorand.account.fromEnvironment("DEPLOYER");

  const factory = algorand.client.getTypedAppFactory(GGovRegistryFactory, {
    defaultSender: deployer.addr,
  });

  const { appId } = await factory.getAppClientByCreatorAndName({ creatorAddress: deployer.addr, appName: "GGovRegistry" });

  console.log({ appId });
  const { balance } = await algorand.account.getInformation(deployer.addr);
  console.log("Deployer", deployer.addr.toString(), "balance:", balance.algos);

  const sdk = new GGovRegistrySDK({
    algorand,
    writerAccount: { sender: deployer.addr, signer: deployer.signer },
    registryAppId: appId,
    debug: true,
  });

  await sdk.uploadCommitteeFile(file);
  const { minBalance } = await algorand.account.getInformation(sdk.writeClient!.appAddress);
  console.log({ appMinBalance: minBalance.algos });
})();
