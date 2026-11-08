// The comparison of safety net (a), e2e/guard/response-diff.spec.ts: an answer is flattened into cells (path → value),
// and one request's three answers — old build, new build, old build again — are sorted per cell. Old and old again
// differ: noise. They agree and the new build differs: a real difference, or a known one the ignore file lists.

export type Answer = { status: number | string; headers?: Record<string, string>; body: unknown }
export type Cells = Map<string, string>

// A list's rows are paired by what names them, not by position, so a row added at the top is one difference. The
// order of the names is a cell of its own: rows in another order are on the screen too.
const NAME_FIELDS = ['metadata.uid', 'uid', 'uuid', 'id', 'ID', 'fingerprint', 'key'] as const
const at = (o: Record<string, unknown>, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o)

function nameOf(row: Record<string, unknown>): string | null {
  // an event is named by its object, reason and message: its times are what a change moves, and rows of one second have no order
  const object = row.involved_object as Record<string, unknown> | undefined
  if (object && typeof object === 'object') return [object.kind, object.namespace, object.name, row.reason, row.message].join('/')
  for (const f of NAME_FIELDS) {
    const v = at(row, f)
    if (typeof v === 'string' || typeof v === 'number') return String(v)
  }
  const named = (at(row, 'metadata.name') ?? row.name) as unknown
  if (typeof named !== 'string') return null
  const ns = (at(row, 'metadata.namespace') ?? row.namespace) as unknown
  const kind = row.kind ?? row.type
  // a rollout's revisions share the owner's name
  const revision = typeof row.revision === 'string' || typeof row.revision === 'number' ? [String(row.revision)] : []
  return [typeof kind === 'string' ? kind : '', typeof ns === 'string' ? ns : '', named, ...revision].join('/')
}

function rowNames(rows: unknown[]): string[] | null {
  if (rows.length === 0) return null
  // a list of plain values is named by the values: another order is one cell, not a difference at each position
  const plain = rows.every((r) => typeof r === 'string' || typeof r === 'number')
  if (!plain && !rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) return null
  const names = rows.map((r) => (plain ? String(r) : nameOf(r as Record<string, unknown>)))
  if (names.some((n) => n === null)) return null
  if (new Set(names).size === names.length) return names as string[]
  if (plain) return null
  // the same name twice (an event that happened again): each is that name's first, second…
  const seen = new Map<string, number>()
  return (names as string[]).map((name) => {
    const nth = (seen.get(name) ?? 0) + 1
    seen.set(name, nth)
    return nth === 1 ? name : `${name}#${nth}`
  })
}

export function flatten(value: unknown, path = '$', out: Cells = new Map()): Cells {
  if (Array.isArray(value)) {
    const names = rowNames(value)
    out.set(`${path}.$length`, String(value.length))
    if (names) out.set(`${path}.$order`, names.join(' '))
    value.forEach((v, i) => flatten(v, names ? `${path}[${names[i]}]` : `${path}[${i}]`, out))
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0) out.set(path, '{}')
    for (const k of keys) flatten((value as Record<string, unknown>)[k], `${path}.${k}`, out)
  } else {
    out.set(path, JSON.stringify(value) ?? 'undefined')
  }
  return out
}

export function cellsOf(a: Answer): Cells {
  const out = flatten(a.body)
  out.set('$status', String(a.status))
  for (const [k, v] of Object.entries(a.headers ?? {})) out.set(`$header.${k}`, v)
  return out
}

export type Kind = 'changed' | 'added' | 'removed'
export type Difference = { cell: string; kind: Kind; old: string | null; new: string | null }
export type Sorted = { cells: number; real: Difference[]; noise: string[] }

export function sortCells(old1: Answer, fresh: Answer, old2: Answer): Sorted {
  const a = cellsOf(old1)
  const n = cellsOf(fresh)
  const b = cellsOf(old2)
  const real: Difference[] = []
  const noise: string[] = []
  const all = new Set([...a.keys(), ...n.keys(), ...b.keys()])
  for (const cell of all) {
    const o1 = a.get(cell)
    const o2 = b.get(cell)
    const v = n.get(cell)
    if (o1 !== o2) noise.push(cell)
    else if (v !== o1) real.push({ cell, kind: o1 === undefined ? 'added' : v === undefined ? 'removed' : 'changed', old: o1 ?? null, new: v ?? null })
  }
  return { cells: all.size, real, noise }
}

// A known difference: which requests (route), which cells, optionally whose answers (user), why, and the PR that made
// it. A rule with no reason or PR is refused; the file's changes show in the diff of whichever PR adds to it. A rule whose
// cells take in `$status` names the status the new build answers (newStatus), so a server error is never a known difference.
export type IgnoreRule = { route: string; cell: string; user?: string; newStatus?: string; why: string; pr: string }
export function compileRules(rules: IgnoreRule[]): ((route: string, cell: string, user?: string, newStatus?: string) => IgnoreRule | null) {
  const compiled = rules.map((r) => {
    if (!r.why?.trim() || !r.pr?.trim()) throw new Error(`an ignore rule needs a reason and a PR: ${JSON.stringify(r)}`)
    const cell = new RegExp(r.cell)
    if (cell.test('$status') && !r.newStatus) throw new Error(`an ignore rule that takes in $status names newStatus: ${JSON.stringify(r)}`)
    return { rule: r, route: new RegExp(r.route), cell, user: r.user ? new RegExp(r.user) : null, newStatus: r.newStatus ? new RegExp(r.newStatus) : null }
  })
  return (route, cell, user = '', newStatus = '') => compiled.find((c) => c.route.test(route) && c.cell.test(cell)
    && (!c.user || c.user.test(user)) && (!c.newStatus || c.newStatus.test(newStatus)))?.rule ?? null
}

// /api/v1/cluster/pods/x?cluster=self → the same text; rows of the table group by path without the query.
export const routeOf = (key: string) => key.split('?')[0]
