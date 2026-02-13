/**
 * Decorator that ensures the instance has a writerAccount property set before calling the method.
 * Checks for ggovWriterAccount (gGov SDK) or writerAccount (oracle SDK) on the instance.
 * @returns Method decorator
 */
export function requireWriter() {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor): PropertyDescriptor {
    const originalMethod = descriptor.value

    descriptor.value = function (...args: any[]) {
      if (!this || ((this as any).ggovWriterAccount === undefined && (this as any).writerAccount === undefined)) {
        throw new Error(`Method "${propertyKey}" requires a writerAccount to be set on the instance`)
      }

      return originalMethod.apply(this, args)
    }

    return descriptor
  }
}
