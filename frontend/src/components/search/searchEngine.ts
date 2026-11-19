import jsep from 'jsep'
import evaluate from 'simple-eval'
import { formatAge } from '@/utils/time'

export interface SearchResult {
  kind: string
  name: string
  namespace: string
  status?: string
  age?: string
  raw: Record<string, unknown>
}

function getTopLevelKeys(items: Record<string, unknown>[]): string[] {
  const keys = new Set<string>()
  for (const obj of items) {
    if (obj && typeof obj === 'object') {
      for (const key of Object.keys(obj)) keys.add(key)
    }
  }
  return Array.from(keys)
}

function tryParse(query: string): { tree: ReturnType<typeof jsep> } | { unreadable: string } {
  try {
    return { tree: jsep(query) }
  } catch (err) {
    return { unreadable: err instanceof Error ? err.message : String(err) }
  }
}

// The node types simple-eval 2.0.1 computes (the switch of its `reduce`), and the operators of its unary and binary ones.
export const SIMPLE_EVAL_NODES = [
  'Program', 'ExpressionStatement', 'MemberExpression', 'LogicalExpression', 'ConditionalExpression', 'BinaryExpression',
  'UnaryExpression', 'CallExpression', 'NewExpression', 'ArrayExpression', 'ThisExpression', 'Identifier', 'Literal',
]
const UNARY_OPERATORS = ['!', '-', '+', '~', 'typeof', 'void', 'delete']
const BINARY_OPERATORS = ['-', '+', '==', '!=', '===', '!==', '<', '<=', '>', '>=', '<<', '>>', '>>>', '*', '/', '%', '**', '|', '^', '&', 'in', 'instanceof', '&&', '||', '??']

type TreeNode = { type: string; [field: string]: unknown }

// The SyntaxError simple-eval 2.0.1 throws for the tree's form, in its words and in the order it computes the tree, read
// from the tree alone: it throws it whatever the data, but only once the data before it computed (`spec.x && !!data`).
export function refusedForm(node: TreeNode): string | undefined {
  const first = (...children: unknown[]) => {
    for (const child of children) {
      const why = refusedForm(child as TreeNode)
      if (why) return why
    }
    return undefined
  }
  if (!SIMPLE_EVAL_NODES.includes(node.type)) return 'Unexpected node'
  switch (node.type) {
    case 'Program': {
      const body = node.body as unknown[]
      return body.length !== 1 ? 'Too complex expression' : first(body[0])
    }
    case 'ExpressionStatement':
      return first(node.expression)
    case 'MemberExpression':
      return first(node.object, ...((node.property as TreeNode).type === 'Identifier' ? [] : [node.property]))
    case 'LogicalExpression':
    case 'BinaryExpression':
      return first(node.left, node.right) ?? (BINARY_OPERATORS.includes(node.operator as string)
        ? undefined
        : `Unsupported ${node.type === 'LogicalExpression' ? 'logical' : 'binary'} operator: ${node.operator}`)
    case 'ConditionalExpression':
      return first(node.test, node.consequent, node.alternate)
    case 'UnaryExpression':
      if (!node.prefix || (node.argument as TreeNode).type === 'UnaryExpression') return 'Unexpected operator'
      if (!UNARY_OPERATORS.includes(node.operator as string)) return `Unsupported unary operator: ${node.operator}`
      return first(node.argument)
    case 'CallExpression':
    case 'NewExpression':
      return first(node.callee, ...(node.arguments as unknown[]))
    case 'ArrayExpression':
      return first(...(node.elements as unknown[]).filter((el) => el !== null))
    default:
      return undefined
  }
}

// `unreadable`: why the expression cannot be searched — jsep could not parse it, or simple-eval refuses its form, which
// the form gives whatever the objects hold, none too. An error from an object's data (a field it lacks) only leaves that
// object out.
export async function searchWithExpression(
  items: Record<string, unknown>[],
  query: string,
  interruptRef: { current: boolean },
): Promise<{ results: Record<string, unknown>[]; timeMs: number; unreadable?: string }> {
  const start = performance.now()
  if (!query.trim()) return { results: [], timeMs: 0 }

  const parsed = tryParse(query)
  if ('unreadable' in parsed) return { results: [], timeMs: 0, unreadable: parsed.unreadable }
  const refused = refusedForm(parsed.tree as TreeNode)
  if (refused) return { results: [], timeMs: 0, unreadable: refused }

  const dummyKeys: Record<string, undefined> = {}
  getTopLevelKeys(items).forEach(k => { dummyKeys[k] = undefined })

  const results: Record<string, unknown>[] = []
  const batchSize = 500

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const meta = (item.metadata ?? {}) as Record<string, unknown>
    const shortcuts = {
      namespace: meta.namespace ?? '',
      name: meta.name ?? '',
      labels: meta.labels ?? {},
      annotations: meta.annotations ?? {},
    }
    try {
      const res = evaluate(parsed.tree as any, { ...dummyKeys, ...shortcuts, ...item })
      if (res === true) results.push(item)
    } catch (err) {
      if (err instanceof SyntaxError) return { results: [], timeMs: performance.now() - start, unreadable: err.message }
    }

    if ((i + 1) % batchSize === 0 || i === items.length - 1) {
      await new Promise(r => setTimeout(r, 0))
      if (interruptRef.current) return { results: [], timeMs: 0 }
    }
  }

  return { results, timeMs: performance.now() - start }
}

export { formatAge }

// The server sends each object's kubectl STATUS beside the list (printer_status, the Status column of kubectl get's
// table); it is kept per object here because the objects go into the expressions as the API wrote them.
const printerStatus = new WeakMap<object, string>()

export function rememberPrinterStatus(item: object, status: string) {
  printerStatus.set(item, status)
}

// kubectl's STATUS where the kind prints one; otherwise the phase or the Ready/Available condition.
export function extractStatus(item: Record<string, unknown>): string {
  const printed = printerStatus.get(item)
  if (printed !== undefined) return printed || '-'
  const status = item.status as Record<string, unknown> | undefined
  if (!status) return '-'
  if (typeof status.phase === 'string') return status.phase
  const conditions = status.conditions as Array<Record<string, unknown>> | undefined
  if (Array.isArray(conditions)) {
    const ready = conditions.find(c => c.type === 'Ready' || c.type === 'Available')
    if (ready) return ready.status === 'True' ? 'Ready' : 'NotReady'
  }
  return '-'
}

export type SearchSortKey = 'kind' | 'name' | 'namespace' | 'status' | 'age'

const createdAt = (r: SearchResult) => {
  const ts = Date.parse(String((r.raw?.metadata as Record<string, unknown> | undefined)?.creationTimestamp ?? ''))
  return Number.isNaN(ts) ? -Infinity : ts
}

// The results table's ascending order: Age by creation time, the youngest first as a smaller AGE (an object without
// one last), the other columns as text — the Age text ("9h", "10d") does not sort as text.
export function compareResults(a: SearchResult, b: SearchResult, key: SearchSortKey): number {
  if (key === 'age') {
    const ta = createdAt(a)
    const tb = createdAt(b)
    return ta === tb ? 0 : tb > ta ? 1 : -1
  }
  return String(a[key] ?? '').localeCompare(String(b[key] ?? ''))
}

// A cluster-scoped object's namespace is '' (the table shows "-"), so its drawer opens as <Kind>/<name>.
export function toSearchResult(item: Record<string, unknown>): SearchResult {
  const meta = (item.metadata ?? {}) as Record<string, unknown>
  return {
    kind: (item.kind as string) ?? '-',
    name: (meta.name as string) ?? '-',
    namespace: (meta.namespace as string) ?? '',
    status: extractStatus(item),
    age: formatAge(meta.creationTimestamp as string | undefined),
    raw: item,
  }
}
