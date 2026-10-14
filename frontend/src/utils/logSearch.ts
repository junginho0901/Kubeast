// Splitting a log line around what a log search matched, for highlighting.

export interface LinePart {
  text: string
  match: boolean
}

// The parts of line, with the matches of query marked: a literal (optionally case-insensitive)
// or a regular expression. A pattern JavaScript cannot compile, or one that matches empty, leaves
// the line unmarked — the server's RE2 decided which lines came back.
export function highlightParts(line: string, query: string, regex: boolean, ignoreCase: boolean): LinePart[] {
  if (!query) return [{ text: line, match: false }]
  let re: RegExp
  try {
    const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    re = new RegExp(source, ignoreCase ? 'gi' : 'g')
  } catch {
    return [{ text: line, match: false }]
  }
  const parts: LinePart[] = []
  let last = 0
  for (const m of line.matchAll(re)) {
    if (m[0] === '') return [{ text: line, match: false }]
    const at = m.index ?? 0
    if (at > last) parts.push({ text: line.slice(last, at), match: false })
    parts.push({ text: m[0], match: true })
    last = at + m[0].length
  }
  if (last < line.length) parts.push({ text: line.slice(last), match: false })
  return parts.length ? parts : [{ text: line, match: false }]
}

// The range presets offered, up to the server's maximum.
export function rangeOptions(maxMinutes: number): number[] {
  return [15, 60, 360, 1440].filter((m) => m <= maxMinutes)
}

// The bytes the store scanned, as people read them.
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
