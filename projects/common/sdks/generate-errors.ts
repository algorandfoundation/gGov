/**
 * Script to parse errors.algo.ts and generate SDK error map
 * Parses lines like: export const errName = 'ERR:CODE' // Error message
 *
 * Usage: tsx generate-errors.ts <sdk-root-path>
 * Example: tsx ../common/sdks/generate-errors.ts .
 */
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const sdkRoot = process.argv[2]
if (!sdkRoot) {
  console.error('Usage: tsx generate-errors.ts <sdk-root-path>')
  process.exit(1)
}

const errorsFilePath = resolve(sdkRoot, '../contracts/smart_contracts/base/errors.algo.ts')
const outputFilePath = resolve(sdkRoot, 'src/generated/errors.ts')

const content = readFileSync(errorsFilePath, 'utf-8')

// Match lines like: export const errName = 'CODE' // Message
// The contract constants hold the bare code; loggedAssert/loggedErr prepend the "ERR:" prefix
// on-chain, so we reconstruct the full "ERR:CODE" key here to match what surfaces at runtime.
const errorRegex = /export const \w+ = '([A-Z0-9_]+)'\s*\/\/\s*(.+)$/gm

const errors: Record<string, string> = {}
const duplicates: string[] = []
let match: RegExpExecArray | null

while ((match = errorRegex.exec(content)) !== null) {
  const [, rawCode, message] = match
  const code = `ERR:${rawCode}`
  if (Object.prototype.hasOwnProperty.call(errors, code)) {
    duplicates.push(`${code} (existing: "${errors[code]}", duplicate: "${message.trim()}")`)
    continue
  }
  errors[code] = message.trim()
}

if (duplicates.length > 0) {
  console.error(`Duplicate error code(s) found in ${errorsFilePath}:`)
  for (const dup of duplicates) {
    console.error(`  - ${dup}`)
  }
  console.error('Error codes must be unique. Aborting.')
  process.exit(1)
}

const output = `// Auto-generated from errors.algo.ts - do not edit manually

/**
 * Map of error codes to human-readable error messages
 */
export const ErrorMessages: Record<string, string> = ${JSON.stringify(errors, null, 2)};
`

writeFileSync(outputFilePath, output)
console.log(`Generated ${Object.keys(errors).length} error messages to ${outputFilePath}`)
