// What the Gateway API drawers write from conditions and references: the same words as the list pages and kubectl.

type Condition = { type?: unknown; status?: unknown }

const holds = (c: Condition, status: string) => String(c?.status ?? '').toLowerCase() === status

// A condition's status as kubectl's printer column prints it (`.status.conditions[?(@.type=="Programmed")].status`):
// True, False or Unknown as written, '-' without a condition of that type. A route's conditions are its parents'
// pooled: True when one parent says so (as the list counts it Accepted), else the first parent's value.
export function conditionStatus(conditions: Condition[] | undefined, type: string): string {
  const of = (Array.isArray(conditions) ? conditions : []).filter((c) => String(c?.type) === type)
  const shown = of.find((c) => holds(c, 'true')) ?? of[0]
  return String(shown?.status ?? '') || '-'
}

// The list pages' Status column (gatewayrow.summary): the first of `first` that holds, else the first condition that
// holds, else the first that does not as "<type>(False)", else Unknown.
export function conditionSummary(conditions: Condition[] | undefined, ...first: string[]): string {
  const list = (Array.isArray(conditions) ? conditions : []).filter((c) => String(c?.type ?? '') !== '')
  const named = first.find((type) => list.some((c) => String(c.type) === type && holds(c, 'true')))
  if (named) return named
  const yes = list.find((c) => holds(c, 'true'))
  if (yes) return String(yes.type)
  const no = list.find((c) => holds(c, 'false'))
  return no ? `${String(no.type)}(False)` : 'Unknown'
}

function text(value: unknown): string {
  if (value == null) return '-'
  const s = String(value)
  return s.length > 0 ? s : '-'
}

// A parent or ancestor reference: Kind.group/name (ns=…, section=…, port=…).
export function formatParentRef(parentRef: Record<string, any>): string {
  if (!parentRef || typeof parentRef !== 'object') return '-'
  const group = text(parentRef.group)
  const kind = text(parentRef.kind)
  const namespace = text(parentRef.namespace)
  const name = text(parentRef.name)
  const sectionName = text(parentRef.sectionName || parentRef.section_name)
  const port = text(parentRef.port)

  const head = [kind, group !== '-' ? `.${group}` : '', `/${name}`].join('')
  const extras = [
    namespace !== '-' ? `ns=${namespace}` : '',
    sectionName !== '-' ? `section=${sectionName}` : '',
    port !== '-' ? `port=${port}` : '',
  ].filter(Boolean)

  if (extras.length === 0) return head
  return `${head} (${extras.join(', ')})`
}
