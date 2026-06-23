/**
 * Deploy GGov contract to localnet and seed a full active governance session.
 *
 * Usage (from repo root):
 *   npx tsx projects/ggov-frontend/scripts/deploy-sample-data.ts
 *   OR from ggov-frontend:
 *   npx tsx scripts/deploy-sample-data.ts
 *
 * Requires: algokit localnet running, SDKs built (ggov-sdk dist).
 *
 * Resets localnet, then uses the KMD default wallet accounts as committee members
 * (so they persist and can connect + vote via the frontend). Seeds three periods —
 * an ENDED council election (id 1), an ACTIVE council election (id 2), and an
 * UPCOMING standard vote (id 3) — with
 * votes and delegations cast so the results pages, the live council standings, and
 * the multi-account voting record are all populated. Random transaction notes
 * deduplicate otherwise-identical calls (no sleeps needed). Finally rewrites the
 * frontend .env with the new registry app id.
 *
 * Delegation story (connect as the deployer/operator to see it on the ended period):
 *   - Member B delegates to A (deployer); A casts B's ballot  → "Delegated to you"
 *   - Member C delegates to A but votes directly (locked)     → "Voted directly"
 *   - A votes its own ballot                                  → "Your account"
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
const { GGovSDK, GGovRegistrySDK } = require("../../ggov-sdk/dist/index.js");
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

  // Fund deployer (pays registry + 3 period MBRs, vote-record boxes, and its own votes)
  await algorand.send.payment({
    sender: dispenser.addr,
    receiver: deployerAddr,
    amount: (300 as any).algo(),
  });

  // ── Deploy GGovRegistry contract ──────────────────────────────────

  console.log("\nDeploying GGovRegistry contract via GGovRegistrySDK.createRegistry()...");
  const { appClient } = await GGovRegistrySDK.createRegistry({
    algorand,
    deployer: {
      sender: deployerAddr,
      signer: algorand.account.getSigner(deployerAddr),
    },
    operatorAccount: deployerAddr,
    initialFundingAlgos: 50n,
  });
  // Combined SDK for period ops; registry ops go through sdk.registry.
  const sdk = new GGovSDK({
    algorand,
    registryAppId: appClient.appId,
    writerAccount: { sender: deployerAddr, signer: algorand.account.getSigner(deployerAddr) },
  });
  const appId = appClient.appId;
  console.log(`GGovRegistry deployed! App ID: ${appId}`);
  console.log(`App address: ${appClient.appAddress}`);
  console.log("Operator set to deployer");

  // ── Generate 5 external committee accounts (B..F) ──────────────────
  // These are standalone accounts (NOT added to the KMD wallet) so that, when the
  // dev connects the deployer A in the frontend, the accounts that delegate to A
  // (B, C) read as external delegators — "Delegated to you" / "Voted directly" —
  // rather than the wallet's own accounts. Their signers are auto-registered.

  console.log("\nGenerating 5 external committee accounts (B..F)...");
  const generatedAddresses: string[] = [];
  for (let i = 0; i < 5; i++) {
    const acct = algorand.account.random();
    generatedAddresses.push(acct.addr.toString());
    console.log(`  Generated account ${i + 1}: ${acct.addr.toString().slice(0, 12)}...`);
  }

  // Deployer (A, in the KMD wallet) + 5 external accounts (B..F) as committee
  // members, with distinct power so council scores spread and the cutoff is clear.
  const memberAddresses = [deployerAddr, ...generatedAddresses];
  const memberVotes = [200, 150, 120, 90, 60, 30];
  console.log(`\nUsing ${memberAddresses.length} accounts as committee members:`);

  for (let i = 0; i < memberAddresses.length; i++) {
    const addr = memberAddresses[i];
    const role = addr === deployerAddr ? " (admin/operator, KMD wallet)" : " (external)";
    // Fund every non-deployer member enough to vote (a multi-topic vote must clear
    // the ~643_210 µAlgo opcode-budget pre-sim bar).
    if (addr !== deployerAddr) {
      await algorand.send.payment({
        sender: dispenser.addr,
        receiver: addr,
        amount: (20 as any).algo(),
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
  const committeeId = await sdk.registry.uploadCommitteeFile(committeeFile);
  const committeeHex = Array.from(committeeId as Uint8Array)
    .map((b: number) => b.toString(16).padStart(2, "0"))
    .join("");
  console.log(`Committee ID: ${committeeHex}`);

  // Release KMD wallet handle (signers are already registered with AlgorandClient).
  await kmd.releaseWalletHandle(walletHandle);

  // ── Session helpers ────────────────────────────────────────────────

  const now = BigInt(Math.floor(Date.now() / 1000));
  const [A, B, C, D, E, F] = memberAddresses;
  const [pA, pB, pC, pD, pE, pF] = memberVotes;

  // Per-voter SDK (writer = that account); reuse the main `sdk` for the deployer A
  // (used both for A's own votes and for A casting a delegator's ballot).
  const voterSdk = (addr: string) =>
    addr === deployerAddr
      ? sdk
      : new GGovSDK({
          algorand,
          registryAppId: appId,
          writerAccount: { sender: addr, signer: algorand.account.getSigner(addr) },
        });

  // Create a period: future window first (so topics can be added), upload body
  // (with electSeats for a council election), add topics, then set the real
  // window and mark ready.
  async function createPeriod(opts: {
    title: string;
    body: string;
    electSeats?: number;
    topics: { title: string; body: string; options?: string[] }[];
    votingStart: bigint;
    votingEnd: bigint;
  }): Promise<bigint> {
    const periodId = (await sdk.registry.addPeriod({
      committeeId,
      votingStart: now + 100000n,
      votingEnd: now + 200000n,
    })) as bigint;
    await sdk.uploadPeriodBody({
      periodId,
      body: {
        title: opts.title,
        body: opts.body,
        ...(opts.electSeats !== undefined ? { electSeats: opts.electSeats } : {}),
      },
    });
    for (const t of opts.topics) {
      const topicIndex = (await sdk.addTopic({
        periodId,
        options: t.options ?? ["Yes", "No", "Abstain"],
        note: randomNote(),
      })) as bigint;
      await sdk.uploadTopicBody({ periodId, topicIndex, body: { title: t.title, body: t.body } });
    }
    await sdk.editPeriod({ periodId, committeeId, votingStart: opts.votingStart, votingEnd: opts.votingEnd });
    await sdk.setReady({ periodId, ready: true });
    return periodId;
  }

  // Fund a period app for per-voter vote-record boxes (3 ALGO covers our committee).
  async function fundPeriodForVotes(periodId: bigint) {
    const periodAppId = await sdk.getPeriodAppId(periodId);
    const periodAppAddr = algosdk.getApplicationAddress(periodAppId).toString();
    await algorand.send.payment({
      sender: deployerAddr,
      receiver: periodAppAddr,
      amount: (3 as any).algo(),
      note: randomNote(),
    });
  }

  // One-hot ballot row: full voting power on the chosen option. Y→0, N→1, A→2.
  const oneHot = (choice: string, power: number): number[] => {
    const idx = choice === "Y" ? 0 : choice === "N" ? 1 : 2;
    return [0, 1, 2].map((i) => (i === idx ? power : 0));
  };

  // Cast `choices` (one per topic) for `voter` with `power`. `castBy` is the signer:
  // the voter itself (direct) or its delegatee (delegated vote).
  async function castBallot(periodId: bigint, voter: string, power: number, choices: string[], castBy: string) {
    const topicVotes = choices.map((c) => oneHot(c, power));
    await voterSdk(castBy).vote({ periodId, voterAccount: voter, topicVotes, note: randomNote() });
  }

  // Global (registry-level) voting-power delegation: `delegator` → `delegatee`.
  async function delegate(delegator: string, delegatee: string) {
    await voterSdk(delegator).registry.setVotingAccount({ votingAddress: delegatee });
  }

  // ── Delegations (global; apply to every period) ────────────────────
  console.log("\nSetting delegations: B→A (delegated), C→A (votes directly)...");
  await delegate(B, A); // B delegates to A; A will cast B's ballot
  await delegate(C, A); // C delegates to A but votes directly → locked ("Voted directly")

  // Council candidates (5), shared by the past and active elections. Each is a
  // Yes/No/Abstain ballot; candidates rank by net score (Yes − No) for the seats.
  const candidateTopics = [
    { title: "txnlab.algo", body: "AlgoKit core maintainer and developer tooling." },
    { title: "folks.algo", body: "Folks Finance lending protocol contributor." },
    { title: "nodely.algo", body: "Infrastructure, indexer and node operator." },
    { title: "reti.algo", body: "Reti staking pool collective." },
    { title: "gard.algo", body: "GARD stablecoin protocol team." },
  ];

  // ── 1) ENDED (past) council election ───────────────────────────────
  // The contract blocks editPeriod once a period is `ready` (and voting requires
  // ready), and setReady(false) is blocked once votes exist — so a voted period
  // can't be backdated. Instead give it a short window, cast within it, then let
  // wall-clock pass votingEnd; the frontend derives "ended" from votingEnd vs now.
  console.log("\nCreating ENDED council election (id 1; 3 seats, 5 candidates)...");
  const endedStart = BigInt(Math.floor(Date.now() / 1000));
  const endedVotingEnd = endedStart + 90n; // short window: cast within it, then it lapses
  const endedId = await createPeriod({
    title: "gGov Council — Term 1 election",
    body: "Elect 3 council members. Each candidate below is a Yes/No/Abstain ballot; candidates are ranked by net score (Yes − No) and the top 3 took the available seats.",
    electSeats: 3,
    topics: candidateTopics,
    votingStart: endedStart - 3600n,
    votingEnd: endedVotingEnd,
  });
  await fundPeriodForVotes(endedId);
  // Ballots per candidate [c0..c4], designed for a descending ranking with one negative.
  const endedBallots: Record<string, string[]> = {
    [A]: ["Y", "Y", "Y", "Y", "N"],
    [B]: ["Y", "Y", "Y", "A", "N"],
    [C]: ["Y", "Y", "Y", "N", "A"],
    [D]: ["Y", "Y", "N", "N", "A"],
    [E]: ["Y", "N", "N", "N", "Y"],
    [F]: ["Y", "N", "N", "Y", "N"],
  };
  await castBallot(endedId, A, pA, endedBallots[A], A);
  await castBallot(endedId, B, pB, endedBallots[B], A); // delegated: A casts for B
  await castBallot(endedId, C, pC, endedBallots[C], C); // direct (delegation locked)
  await castBallot(endedId, D, pD, endedBallots[D], D);
  await castBallot(endedId, E, pE, endedBallots[E], E);
  await castBallot(endedId, F, pF, endedBallots[F], F);
  // Wait for the voting window to lapse so the period reads as ENDED in the UI.
  const waitMs = Number(endedVotingEnd) * 1000 + 2000 - Date.now();
  if (waitMs > 0) {
    console.log(`  Waiting ${Math.ceil(waitMs / 1000)}s for the voting window to close...`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  console.log(`Council election period #${endedId} is ENDED with votes cast`);

  // ── 2) ACTIVE council election ─────────────────────────────────────
  console.log("\nCreating ACTIVE council election (id 2; 3 seats, 5 candidates)...");
  const activeId = await createPeriod({
    title: "gGov Council — Term 2 election",
    body: "Elect 3 council members. Each candidate below is a Yes/No/Abstain ballot; candidates are ranked by net score (Yes − No) and the top 3 lead for the available seats.",
    electSeats: 3,
    topics: candidateTopics,
    votingStart: now - 3600n,
    votingEnd: now + 86400n * 7n,
  });
  await fundPeriodForVotes(activeId);
  const activeBallots: Record<string, string[]> = {
    [A]: ["Y", "Y", "Y", "Y", "N"],
    [B]: ["Y", "Y", "Y", "Y", "N"],
    [C]: ["Y", "Y", "Y", "A", "N"],
    [D]: ["Y", "Y", "Y", "N", "A"],
    [E]: ["Y", "Y", "N", "N", "A"],
    [F]: ["Y", "N", "N", "N", "Y"],
  };
  await castBallot(activeId, A, pA, activeBallots[A], A);
  await castBallot(activeId, B, pB, activeBallots[B], A); // delegated: A casts for B
  await castBallot(activeId, C, pC, activeBallots[C], C); // direct
  await castBallot(activeId, D, pD, activeBallots[D], D);
  await castBallot(activeId, E, pE, activeBallots[E], E);
  await castBallot(activeId, F, pF, activeBallots[F], F);
  console.log(`Council election period #${activeId} is ACTIVE with votes cast`);

  // ── 3) UPCOMING (future) standard period ───────────────────────────
  console.log("\nCreating UPCOMING standard period (id 3)...");
  const upcomingId = await createPeriod({
    title: "Q2 2026 Governance",
    body: "Upcoming governance period covering protocol upgrades and ecosystem strategy.",
    topics: [
      { title: "Protocol Upgrade v2.0", body: "Approve deployment of Protocol v2.0 (state proofs, block pipelining)." },
      { title: "Ecosystem Development Fund", body: "Allocate 1M ALGO to an ecosystem development fund for grants and tooling." },
    ],
    votingStart: now + 86400n * 14n,
    votingEnd: now + 86400n * 28n,
  });
  console.log(`Standard period #${upcomingId} is UPCOMING (starts in 14 days)`);

  // ── Update .env with app ID ───────────────────────────────────────

  const envPath = path.resolve(__dirname, "../.env");
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, "utf-8");
    envContent = envContent.replace(/VITE_GGOV_(REGISTRY_)?APP_ID=.*/, `VITE_GGOV_REGISTRY_APP_ID=${appId}`);
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
  console.log(`Committee:     ${committeeHex.slice(0, 16)}... (${memberAddresses.length} members)`);
  console.log(`Period #${endedId}:  ENDED council election (3 seats, 5 candidates, votes + delegations)`);
  console.log(`Period #${activeId}:  ACTIVE council election (3 seats, 5 candidates, votes cast)`);
  console.log(`Period #${upcomingId}:  UPCOMING standard vote (2 topics, starts in 14 days)`);
  console.log(`\nDelegations: B→A (delegated to you), C→A (voted directly).`);
  console.log("Connect as the deployer/operator account below to see the voting record + your votes:");
  console.log(`  ${deployerAddr}`);
  console.log(`\nCommittee members (${memberAddresses.length} total; A is in the KMD wallet, B..F are external):`);
  memberAddresses.forEach((addr: string, i: number) => {
    const label = addr === deployerAddr ? "A (admin/operator, KMD wallet)" : `${String.fromCharCode(65 + i)} (external)`;
    console.log(`  Member${i + 1}: ${addr.slice(0, 12)}... (${memberVotes[i]} votes) — ${label}`);
  });
  console.log("\nReady! Run: cd projects/ggov-frontend && pnpm dev");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
