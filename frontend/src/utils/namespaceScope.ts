// Namespace-scope lists as typed into the grant and request forms: comma or
// whitespace separated, trimmed, lowercase, deduplicated, sorted — the shape
// auth-service normalizes to (at most 50 per grant).
export const MAX_GRANT_NAMESPACES = 50

export function parseNamespaceList(text: string): string[] {
  const seen = new Set<string>()
  for (const raw of text.split(/[\s,]+/)) {
    const n = raw.trim().toLowerCase()
    if (n) seen.add(n)
  }
  return [...seen].sort()
}

export function sameNamespaces(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? []
  const y = b ?? []
  return x.length === y.length && x.every((v, i) => v === y[i])
}
