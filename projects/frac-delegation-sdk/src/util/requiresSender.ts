/** Verbatim copy of ggov-sdk/src/util/requiresSender.ts */
/**
 * Decorator that ensures the instance has a `writerAccount` property set before calling the method.
 * @returns Method decorator
 */
export function requireWriter() {
  return createRequireWriterDecorator(false)
}

/**
 * Decorator that ensures the instance has `writerAccount` and `writeClient` properties set before calling the method.
 * @returns Method decorator
 */
export function requireWriterWithClient() {
  return createRequireWriterDecorator(true)
}

function createRequireWriterDecorator(requireWriteClient: boolean) {
  return function (_target: object, propertyKey: string, descriptor: PropertyDescriptor): PropertyDescriptor {
    const originalMethod = descriptor.value

    descriptor.value = function (...args: unknown[]) {
      const instance = this as { writerAccount?: unknown; writeClient?: unknown } | undefined
      if (!instance || instance.writerAccount === undefined) {
        throw new Error(`Method "${propertyKey}" requires a writerAccount to be set on the instance`)
      }
      if (requireWriteClient && instance.writeClient === undefined) {
        throw new Error(`Method "${propertyKey}" requires a writeClient to be set on the instance`)
      }

      return originalMethod.apply(this, args)
    }

    return descriptor
  }
}
