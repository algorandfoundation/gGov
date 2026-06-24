import { GGovRegistrySDK, calculateCommitteeId } from '..'
import { getAlgorand, resolveRegistryAppId } from './env'
import { readFileSync } from 'fs'
void (async () => {
  const file = JSON.parse(readFileSync(process.argv[2], 'utf-8'))

  const algorand = getAlgorand()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  const appId = await resolveRegistryAppId(algorand, deployer.addr)

  console.log({ appId })

  const sdk = new GGovRegistrySDK({
    algorand,
    writerAccount: { sender: deployer.addr, signer: deployer.signer },
    registryAppId: appId,
  })

  const id = calculateCommitteeId(JSON.stringify(file))
  console.log({ id: Buffer.from(id).toString('base64') })

  console.time('fetch')
  const comm = (await sdk.fastGetCommittee(id))!
  console.timeEnd('fetch')
  // console.log(JSON.stringify(comm));
  if (comm) {
    for (const [key, value] of Object.entries(file)) {
      if (key === 'xGovs') continue
      if (value !== comm[key as keyof typeof comm]) {
        console.error(`Mismatch on ${key}: expected ${value}, got ${comm[key as keyof typeof comm]}`)
      }
    }
    const max = Math.max(file.xGovs.length, comm.xGovs.length)
    for (let i = 0; i < max; i++) {
      const expected = file.xGovs[i]
      const got = comm.xGovs[i]
      if (!expected) {
        console.error(`Extra xGov in stored committee: ${JSON.stringify(got)}`)
        continue
      }
      if (!got) {
        console.error(`Missing xGov in stored committee: ${JSON.stringify(expected)}`)
        continue
      }
      if (expected.address !== got.address || expected.votes !== got.votes) {
        console.error(`Mismatch on xGov index ${i}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`)
      }
    }
    console.log('Files match')
  }
  comm.networkGenesisHash = file.networkGenesisHash
  const commId = calculateCommitteeId(JSON.stringify(comm))
  if (Buffer.from(commId).toString('base64') !== Buffer.from(id).toString('base64')) {
    console.error(
      `Recalculated committee ID mismatch: expected ${Buffer.from(id).toString('base64')}, got ${Buffer.from(commId).toString('base64')}`,
    )
  } else {
    console.log('Committee ID matches on recalculation')
  }
})()
