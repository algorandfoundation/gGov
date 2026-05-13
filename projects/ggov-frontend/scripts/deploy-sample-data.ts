/**
 * Deploy GGov contract to localnet and create sample governance data.
 *
 * Usage (from repo root):
 *   npx tsx projects/contracts/smart_contracts/ggov/deploy-sample.ts
 *   OR from ggov-frontend:
 *   npx tsx scripts/deploy-sample-data.ts
 *
 * Requires: algokit localnet running, SDKs built
 *
 * This script resets localnet first, then uses the existing KMD default wallet
 * accounts as committee members so they persist and can vote via the frontend.
 * Random transaction notes are used to deduplicate identical calls (no sleeps needed).
 */

import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use require for packages that have CJS dist but ESM source issues
const { AlgorandClient } = require("@algorandfoundation/algokit-utils");
const { GGovRegistryFactory } = require("../../ggov-sdk/dist/generated/GGovRegistryClient.js");
const { GGovSDK } = require("../../ggov-sdk/dist/sdk.js");
const algosdk = require("algosdk");

interface XGovCommitteeFile {
  networkGenesisHash: string;
  periodEnd: number;
  periodStart: number;
  registryId: number;
  totalMembers: number;
  totalVotes: number;
  xGovs: Array<{ address: string; votes: number }>;
}

const KMD_TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** Generate a random 8-byte note to deduplicate otherwise-identical transactions. */
function randomNote(): Uint8Array {
  return new Uint8Array(randomBytes(8));
}

const LOCALNET_CONFIG = {
  algodConfig: {
    server: "http://localhost",
    port: 4001,
    token: KMD_TOKEN,
  },
  indexerConfig: {
    server: "http://localhost",
    port: 8980,
    token: KMD_TOKEN,
  },
  kmdConfig: {
    server: "http://localhost",
    port: 4002,
    token: KMD_TOKEN,
  },
};

async function getKmdDefaultWalletHandle(kmd: any): Promise<string> {
  const { wallets } = await kmd.listWallets();
  const defaultWallet = wallets.find((w: any) => w.name === "unencrypted-default-wallet");
  if (!defaultWallet) throw new Error("Could not find unencrypted-default-wallet in KMD");
  const { wallet_handle_token } = await kmd.initWalletHandle(defaultWallet.id, "");
  return wallet_handle_token;
}

async function getKmdAccounts(kmd: any, walletHandle: string): Promise<string[]> {
  const { addresses } = await kmd.listKeys(walletHandle);
  return addresses as string[];
}

/** Generate a new account in the KMD default wallet and return its address. */
async function generateKmdAccount(kmd: any, walletHandle: string): Promise<string> {
  const { address } = await kmd.generateKey(walletHandle);
  return address as string;
}

/** Export a private key from KMD and register the signer with AlgorandClient. */
async function registerKmdAccount(kmd: any, walletHandle: string, address: string, algorand: any): Promise<void> {
  const { private_key } = await kmd.exportKey(walletHandle, "", address);
  const account = algosdk.mnemonicToSecretKey(algosdk.secretKeyToMnemonic(private_key));
  algorand.account.setSignerFromAccount(account);
}

async function main() {
  // ── Reset localnet ──────────────────────────────────────────────────
  console.log("Resetting localnet...");
  execSync("algokit localnet reset", { stdio: "inherit" });
  // Give localnet a moment to come back up
  await new Promise((r) => setTimeout(r, 3000));

  console.log("Connecting to localnet...");
  const algorand = AlgorandClient.fromConfig(LOCALNET_CONFIG);

  // Set up KMD client and get existing accounts from default wallet
  const kmd = new algosdk.Kmd(KMD_TOKEN, "http://localhost", 4002);
  const walletHandle = await getKmdDefaultWalletHandle(kmd);
  const kmdAddresses = await getKmdAccounts(kmd, walletHandle);
  console.log(`Found ${kmdAddresses.length} accounts in KMD default wallet`);

  // Get the default localnet dispenser account
  const dispenser = await algorand.account.localNetDispenser();
  const dispenserAddr = dispenser.addr.toString();
  console.log(`Dispenser: ${dispenserAddr}`);

  // Use the first non-dispenser KMD account as deployer
  const nonDispenserAccounts = kmdAddresses.filter((a: string) => a !== dispenserAddr);
  if (nonDispenserAccounts.length < 1) {
    throw new Error(`Need at least 1 non-dispenser KMD account for deployer, found ${nonDispenserAccounts.length}`);
  }

  const deployerAddr = nonDispenserAccounts[0];
  console.log(`Deployer: ${deployerAddr}`);

  // Register deployer signer from KMD
  await registerKmdAccount(kmd, walletHandle, deployerAddr, algorand);

  // Fund deployer
  await algorand.send.payment({
    sender: dispenser.addr,
    receiver: deployerAddr,
    amount: (100 as any).algo(),
  });

  // ── Deploy GGovRegistry contract ──────────────────────────────────

  console.log("\nDeploying GGovRegistry contract...");
  const factory = algorand.client.getTypedAppFactory(GGovRegistryFactory, {
    defaultSender: deployerAddr,
  });

  const { appClient } = await factory.deploy({
    onUpdate: "append",
    onSchemaBreak: "append",
  });

  const appId = appClient.appId;
  console.log(`GGovRegistry deployed! App ID: ${appId}`);
  console.log(`App address: ${appClient.appAddress}`);

  // Fund the registry app account for box storage and per-period MBR
  await algorand.send.payment({
    sender: deployerAddr,
    receiver: appClient.appAddress,
    amount: (50 as any).algo(),
  });

  // ── Create SDK instance ───────────────────────────────────────────

  const sdk = new GGovSDK({
    algorand,
    ggovRegistryAppId: appId,
    writerAccount: {
      sender: deployerAddr,
      signer: algorand.account.getSigner(deployerAddr),
    },
    debug: false,
  });

  // Set deployer as operator (must happen via SDK so the writer account is correct)
  await sdk.setOperator({ account: deployerAddr });
  console.log("Operator set to deployer");

  // ── Generate 5 new KMD accounts for committee members ──────────────

  console.log("\nGenerating 5 new KMD accounts...");
  const generatedAddresses: string[] = [];
  for (let i = 0; i < 5; i++) {
    const addr = await generateKmdAccount(kmd, walletHandle);
    generatedAddresses.push(addr);
    console.log(`  Generated account ${i + 1}: ${addr.slice(0, 12)}...`);
  }

  // Use the deployer plus the 5 generated accounts as committee members
  const memberAddresses = [deployerAddr, ...generatedAddresses];
  const memberVotes = [200, 100, 80, 60, 40, 20];
  console.log(`\nUsing ${memberAddresses.length} accounts as committee members:`);

  for (let i = 0; i < memberAddresses.length; i++) {
    const addr = memberAddresses[i];
    const role = addr === deployerAddr ? " (admin/operator)" : "";
    // Deployer signer already registered; register + fund others
    if (addr !== deployerAddr) {
      await registerKmdAccount(kmd, walletHandle, addr, algorand);
      await algorand.send.payment({
        sender: dispenser.addr,
        receiver: addr,
        amount: (10 as any).algo(),
        note: randomNote(),
      });
    }
    console.log(`  Member${i + 1}: ${addr.slice(0, 12)}... (${memberVotes[i]} votes)${role}`);
  }

  const committeeFile: XGovCommitteeFile = {
    networkGenesisHash: "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    periodStart: 50000000,
    periodEnd: 53000000,
    registryId: 0,
    totalMembers: memberAddresses.length,
    totalVotes: memberVotes.reduce((a: number, b: number) => a + b, 0),
    xGovs: memberAddresses.map((addr: string, i: number) => ({
      address: addr,
      votes: memberVotes[i],
    })),
  };

  console.log("Uploading committee file...");
  const committeeId = await sdk.uploadCommitteeFile(committeeFile);
  const committeeHex = Array.from(committeeId as Uint8Array)
    .map((b: number) => b.toString(16).padStart(2, "0"))
    .join("");
  console.log(`Committee ID: ${committeeHex}`);

  // Release KMD wallet handle
  await kmd.releaseWalletHandle(walletHandle);

  // ── Create an ACTIVE voting period ────────────────────────────────

  console.log("\nCreating active voting period...");
  const now = BigInt(Math.floor(Date.now() / 1000));

  // First create with future start so we can add topics
  const periodId = await sdk.addPeriod({
    committeeId,
    votingStart: now + 10000n,
    votingEnd: now + 20000n,
  });
  console.log(`Period #${periodId} created`);

  // Upload period body
  console.log("Uploading period body...");
  await sdk.uploadPeriodBody({
    periodId: periodId!,
    body: {
      title: "Q1 2026 Governance",
      body: "Vote on key proposals for the Q1 2026 governance period. Topics include staking rewards, community grants, and governance duration.",
    },
  });

  // Add topics (all Yes/No/Abstain — random notes prevent duplicate txn IDs)
  console.log("Adding topics...");

  const topic1Id = await sdk.addTopic({
    periodId: periodId!,
    options: ["Yes", "No", "Abstain"],
    note: randomNote(),
  });
  await sdk.uploadTopicBody({
    periodId: periodId!,
    topicIndex: topic1Id!,
    body: {
      title: "Increase Staking Rewards",
      body: "Proposal to increase staking rewards from 5% to 7% APY to incentivize long-term participation in governance.",
    },
  });
  console.log("  Topic 1: Increase Staking Rewards");

  const topic2Id = await sdk.addTopic({
    periodId: periodId!,
    options: ["Yes", "No", "Abstain"],
    note: randomNote(),
  });
  await sdk.uploadTopicBody({
    periodId: periodId!,
    topicIndex: topic2Id!,
    body: {
      title: "Community Grant Proposal #42",
      body: "Fund the open-source DeFi analytics dashboard project with 50,000 ALGO from the community treasury.",
    },
  });
  console.log("  Topic 2: Community Grant Proposal #42");

  const topic3Id = await sdk.addTopic({
    periodId: periodId!,
    options: ["Yes", "No", "Abstain"],
    note: randomNote(),
  });
  await sdk.uploadTopicBody({
    periodId: periodId!,
    topicIndex: topic3Id!,
    body: {
      title: "Extend Governance Period to 6 Months",
      body: "Change the governance period duration from 3 months to 6 months to reduce voter fatigue and allow more time for deliberation.",
    },
  });
  console.log("  Topic 3: Extend Governance Period to 6 Months");

  // Now edit period to make it active (voting start in the past)
  await sdk.editPeriod({
    periodId: periodId!,
    committeeId,
    votingStart: now - 3600n, // started 1 hour ago
    votingEnd: now + 86400n * 7n, // ends in 7 days
  });
  console.log("Period is now ACTIVE (voting open for 7 days)");

  // ── Create an UPCOMING period ─────────────────────────────────────

  console.log("\nCreating upcoming voting period...");
  const period2Id = await sdk.addPeriod({
    committeeId,
    votingStart: now + 86400n * 14n, // starts in 14 days
    votingEnd: now + 86400n * 28n, // ends in 28 days
  });
  console.log(`Period #${period2Id} created`);

  await sdk.uploadPeriodBody({
    periodId: period2Id!,
    body: {
      title: "Q2 2026 Governance",
      body: "Upcoming governance period covering protocol upgrades and ecosystem strategy.",
    },
  });

  const topic4Id = await sdk.addTopic({
    periodId: period2Id!,
    options: ["Yes", "No", "Abstain"],
    note: randomNote(),
  });
  await sdk.uploadTopicBody({
    periodId: period2Id!,
    topicIndex: topic4Id!,
    body: {
      title: "Protocol Upgrade v2.0",
      body: "Approve the deployment of Protocol v2.0 which includes state proof enhancements and improved block pipelining.",
    },
  });
  console.log("  Topic 1: Protocol Upgrade v2.0");

  const topic5Id = await sdk.addTopic({
    periodId: period2Id!,
    options: ["Yes", "No", "Abstain"],
    note: randomNote(),
  });
  await sdk.uploadTopicBody({
    periodId: period2Id!,
    topicIndex: topic5Id!,
    body: {
      title: "Ecosystem Development Fund",
      body: "Allocate 1M ALGO to an ecosystem development fund for grants, hackathons, and developer tooling.",
    },
  });
  console.log("  Topic 2: Ecosystem Development Fund");

  // ── Update .env with app ID ───────────────────────────────────────

  const envPath = path.resolve(__dirname, "../.env");
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, "utf-8");
    envContent = envContent.replace(
      /VITE_GGOV_(REGISTRY_)?APP_ID=.*/,
      `VITE_GGOV_REGISTRY_APP_ID=${appId}`
    );
    fs.writeFileSync(envPath, envContent);
    console.log(`\n.env updated: VITE_GGOV_REGISTRY_APP_ID=${appId}`);
  } else {
    console.log(`\nNo .env found at ${envPath}. Set VITE_GGOV_REGISTRY_APP_ID=${appId} manually.`);
  }

  // ── Summary ───────────────────────────────────────────────────────

  console.log("\n=== Deployment Summary ===");
  console.log(`App ID:        ${appId}`);
  console.log(`App Address:   ${appClient.appAddress}`);
  console.log(`Operator:      ${deployerAddr}`);
  console.log(`Committee:     ${committeeHex.slice(0, 16)}...`);
  console.log(`Period #${periodId}:  ACTIVE (3 topics, voting open)`);
  console.log(`Period #${period2Id}:  UPCOMING (2 topics, starts in 14 days)`);
  console.log(`\nKMD committee members (${memberAddresses.length} total, all can vote):`);
  memberAddresses.forEach((addr: string, i: number) => {
    const role = addr === deployerAddr ? " (admin/operator)" : " (generated)";
    console.log(`  Member${i + 1}: ${addr.slice(0, 12)}... (${memberVotes[i]} votes)${role}`);
  });
  console.log("\nReady! Run: cd projects/ggov-frontend && pnpm dev");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
