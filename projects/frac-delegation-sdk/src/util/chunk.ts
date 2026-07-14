/** Verbatim copy of ggov-sdk/src/util/chunk.ts */
export function chunk<T>(array: T[], size: number): T[][] {
  const chunkedArr: T[][] = []
  let index = 0
  while (index < array.length) {
    chunkedArr.push(array.slice(index, size + index))
    index += size
  }
  return chunkedArr
}
