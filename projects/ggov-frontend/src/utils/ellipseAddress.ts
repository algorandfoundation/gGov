export function ellipseAddress(address: string | null, width = 6, small = false): string {
  if (small) return address ? `${address.slice(0, width)}..` : (address ?? '')
  return address ? `${address.slice(0, width)}..${address.slice(-width)}` : (address ?? '')
}
