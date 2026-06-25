/**
 * Decorator that ensures the instance has a writerAccount property set before calling the method
 * @returns Method decorator
 */
export function requireWriter() {
  return function (_target: object, propertyKey: string, descriptor: PropertyDescriptor): PropertyDescriptor {
    const originalMethod = descriptor.value

    descriptor.value = function (...args: unknown[]) {
      if (!this || (this as { writerAccount?: unknown }).writerAccount === undefined) {
        throw new Error(`Method "${propertyKey}" requires a writerAccount to be set on the instance`)
      }

      return originalMethod.apply(this, args)
    }

    return descriptor
  }
}
