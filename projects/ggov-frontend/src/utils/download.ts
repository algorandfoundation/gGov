/**
 * Quote a CSV cell only when it needs it — a comma, quote or newline in the value.
 * Both newline characters count: a bare CR is a record delimiter of its own, so an
 * unquoted one would split the document into extra records.
 */
export function csvCell(value: string | number): string {
  const s = String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Build a CSV document from a header row and its body rows. */
export function csvDocument(header: string[], rows: (string | number)[][]): string {
  return [header.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n')
}

/**
 * Hand a generated file to the browser. The object URL is revoked on a timer
 * rather than immediately: Safari reads the href asynchronously after the click.
 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
