import { Config } from '@algorandfoundation/algokit-utils'
import { nullLogger } from '@algorandfoundation/algokit-utils/types/logging'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'

export function configureTestLogging() {
  if (process.env.NOOP_TEST_LOGGER === 'true') {
    Config.configure({ logger: nullLogger })
  } else {
    Config.configure({ debug: true })
    registerDebugEventHandlers()
  }
}
