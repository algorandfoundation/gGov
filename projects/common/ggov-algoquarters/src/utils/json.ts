/** Serialize indented JSON, converting bigint values to decimal strings. */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2) + '\n'
}
