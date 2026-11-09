import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// The drawers of the cluster's configuration, RBAC and admission kinds show the numbers the cluster has: on self, with
// number-check.rbac-drawers-fixture.yaml, Leases of known renew times and events about the objects, each drawer of
// ClusterRole, ClusterRoleBinding, PriorityClass, RuntimeClass, Lease, Mutating/ValidatingWebhookConfiguration and
// Validating/MutatingAdmissionPolicy — opened from its list (search, then the row) and by link — shows in its rows,
// badges, "(n)" titles, cards, chips, tables and notes what the object says (kubectl's columns of these kinds are fields
// of the object, printers.go), the pods `kubectl get pods -A` lists for it, the ClusterRoleBindings and the RoleBindings
// of every namespace whose roleRef is a ClusterRole, and the events kubectl describe lists about it (name, kind and
// uid). The whole drawer is compared, so a number on it that nothing here expects fails too.

const NS = 'e2e-rbac-drawers'
const CLUSTER = 'self'
const KIND_CLUSTER = 'kubeast'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const FIXTURE = fs.readFileSync(path.join(__dirname, 'number-check.rbac-drawers-fixture.yaml'), 'utf8')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
type Kubectl = (args: string, input?: string) => string

// self's kubectl through the kind cluster's kubeconfig; null without the kind cluster
function selfKubectl(): Kubectl | null {
  let kc: string
  try {
    kc = execSync(`kind get kubeconfig --name ${KIND_CLUSTER}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    return null
  }
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-rbac-drawers-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kc, { mode: 0o600 })
  return (args, input) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim()
}

// A drawer as read: the summary badges, the "(n)" of section titles, and per section its rows (label → values), its
// cards (their "Label: value" lines, or their text, and tables), tables, chips, tags (key=value), notes, "Label: value"
// lines outside cards and the remaining texts (a "None" or "-", a description, a node link).
type TableView = { head: string[]; rows: string[][] }
type Card = { lines: Record<string, string>; tables: TableView[] }
type Section = { rows: Record<string, string[]>; cards: Card[]; tables: TableView[]; chips: string[]; tags: string[]; notes: string[]; lines: Record<string, string>; marks: string[] }
type View = { badges: Record<string, string>; counts: Record<string, number>; sections: Record<string, Section> }

async function readDrawer(page: Page): Promise<View> {
  return page.locator(DRAWER).last().evaluate((root) => {
    const txt = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
    const has = (el: Element, ...names: string[]) => names.every((n) => el.classList.contains(n))
    const tableOf = (tb: Element) => ({
      head: [...tb.querySelectorAll('thead th')].map(txt),
      rows: [...tb.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map(txt)),
    })
    // "Label: value": a div whose first element is the grey label ending in ":"
    const isLabel = (el: Element | null): el is Element =>
      !!el && el.tagName === 'SPAN' && (has(el, 'text-slate-400') || has(el, 'text-slate-500')) && txt(el).endsWith(':')
    const linesOf = (els: Element[]) => {
      const out: Record<string, string> = {}
      for (const d of els) {
        const label = d.firstElementChild
        if (!isLabel(label)) continue
        out[txt(label).slice(0, -1)] = txt(d).slice(txt(label).length).trim()
      }
      return out
    }
    const view: View = { badges: {}, counts: {}, sections: {} }
    for (const b of root.querySelectorAll('span.rounded-full')) {
      const bm = has(b, 'py-0.5') ? /^([^:]+): (.*)$/.exec(txt(b)) : null
      if (bm) view.badges[bm[1]] = bm[2]
    }
    for (const sec of root.querySelectorAll('div.rounded-lg.border')) {
      const title = sec.firstElementChild?.firstElementChild
      if (!title || title.tagName !== 'P') continue
      const m = /^(.*) \((\d+)\)$/.exec(txt(title))
      const name = m ? m[1] : txt(title)
      if (m) view.counts[name] = Number(m[2])
      const divs = [...sec.querySelectorAll('div')]
      const cards = divs.filter((d) => has(d, 'rounded-sm', 'border'))
      const inCard = (el: Element) => cards.some((c) => c.contains(el))
      const within = (el: Element, selector: string) => {
        const c = el.closest(selector)
        return !!c && sec.contains(c)
      }
      const rows: Record<string, string[]> = {}
      for (const g of divs.filter((d) => has(d, 'grid') && !inCard(d))) {
        const spans = [...g.children].filter((c) => c.tagName === 'SPAN')
        if (spans.length === 2 && g.children.length === 2 && has(spans[0], 'text-slate-400')) (rows[txt(spans[0])] ??= []).push(txt(spans[1]))
      }
      const spans = [...sec.querySelectorAll('span')]
      view.sections[name] = {
        rows,
        cards: cards.map((c) => {
          const lines = linesOf([...c.querySelectorAll('div')])
          return { lines: Object.keys(lines).length ? lines : { '#': txt(c) }, tables: [...c.querySelectorAll('table')].map(tableOf) }
        }),
        tables: [...sec.querySelectorAll('table')].filter((t) => !inCard(t)).map(tableOf),
        chips: spans.filter((s) => has(s, 'rounded-sm', 'border')).map(txt),
        // a key=value tag: its key and its value, not the tooltip
        tags: spans.filter((s) => has(s, 'rounded-full') && !has(s, 'py-0.5'))
          .map((s) => (s.children.length >= 3 ? `${txt(s.children[0])}=${txt(s.children[2])}` : txt(s))),
        notes: [...sec.querySelectorAll('p')].filter((p) => p !== title && !inCard(p)).map(txt),
        lines: linesOf(divs.filter((d) => !inCard(d))),
        marks: [...sec.querySelectorAll('span, div, button')]
          .filter((el) => el.children.length === 0 && txt(el) !== '' && !inCard(el)
            && !['table', 'p', 'div.grid', 'span.rounded-full', 'span.rounded-sm.border'].some((s) => within(el, s)))
          .map(txt),
      }
    }
    return view
  })
}

// A time the drawer shows is written in what the drawer must show as "@<RFC 3339>" (an age, or "YYYY-MM-DD HH:mm:ss
// (age)"), ">…" (the time until it, as kubectl prints a duration) or "<…" ("expired <age> ago"); a shown time that is
// that one (to the second, a duration within 15 s or 15 %) reads the same, so the rest compares with toEqual.
function seconds(s: string): number {
  const units: Record<string, number> = { y: 31536000, d: 86400, h: 3600, m: 60, s: 1 }
  let total = 0
  for (const m of s.matchAll(/(\d+)([ydhms])/g)) total += Number(m[1]) * units[m[2]]
  return /\d/.test(s) ? total : NaN
}
const close = (shown: string, real: number) => Math.abs(seconds(shown) - real) <= Math.max(15, Math.abs(real) * 0.15)
function sameTime(shown: string, want: string): boolean {
  const at = Date.parse(want.slice(1))
  const since = (Date.now() - at) / 1000
  if (want[0] === '>') return close(shown, -since)
  if (want[0] === '<') {
    const expired = /^expired (.+) ago$/.exec(shown)
    return !!expired && close(expired[1], since)
  }
  const abs = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \((.+)\)$/.exec(shown)
  if (abs) return Math.abs(new Date(`${abs[1]}T${abs[2]}`).getTime() - at) <= 1000 && close(abs[3], since)
  return close(shown, since)
}
function settle(got: unknown, want: unknown): unknown {
  if (typeof want === 'string' && typeof got === 'string' && /^[@<>]/.test(want) && !Number.isNaN(Date.parse(want.slice(1)))) return sameTime(got, want) ? want : got
  if (Array.isArray(got)) return got.map((g, i) => settle(g, Array.isArray(want) ? want[i] : undefined))
  if (got && typeof got === 'object') {
    const w = (want && typeof want === 'object' ? want : {}) as Record<string, unknown>
    return Object.fromEntries(Object.entries(got).map(([k, v]) => [k, settle(v, w[k])]))
  }
  return got
}

// What the drawer must show, in Kubeast's words: an empty value is "-", an empty section "None"
const dash = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v))
const at = (t?: string) => (t ? `@${t}` : '-')
const section = (s: Partial<Section> = {}): Section => ({ rows: {}, cards: [], tables: [], chips: [], tags: [], notes: [], lines: {}, marks: [], ...s })
const rowsOf = (rows: Record<string, string>) => Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, [v]]))
const tagsOf = (m?: Record<string, string>) => Object.entries(m ?? {}).map(([k, v]) => `${k}=${v}`)
const card = (lines: Record<string, string>, tables: TableView[] = []): Card => ({ lines, tables })
// a list longer than its page shows the first page and the pager's range and buttons (usePagination)
const pagerMarks = (total: number, size: number) => (total > size ? [`1-${size} / ${total}`, 'Prev', 'Next'] : [])
// a RuntimeClass's section of the nodes its scheduling.nodeSelector matches (the title before its "(n)")
const NODES_MATCHING = 'Nodes Matching scheduling.nodeSelector'
// newest first, as kubectl's printEvent dates them, ten to a page
const eventsSection = (events: Obj[]) => (events.length
  ? section({
    tables: [{ head: ['Type', 'Reason', 'Message', 'Last Seen', 'Count'], rows: events.slice(0, 10).map((e) => [dash(e.type), dash(e.reason), dash(e.message), at(e.lastTimestamp ?? e.firstTimestamp), String(e.count ?? 1)]) }],
    marks: pagerMarks(events.length, 10),
  })
  : section({ marks: ['None'] }))
// a binding's Subjects cell
const subjectsText = (b: Obj) => ((b.subjects ?? []).length ? b.subjects.map((s: Obj) => `${s.kind || '?'}/${s.name || '-'}`).join(', ') : '-')
// namespace/name in byte order, as the API lists objects of every namespace
const byKey = (a: Obj, b: Obj) => {
  const [x, y] = [`${a.metadata.namespace ?? ''}/${a.metadata.name}`, `${b.metadata.namespace ?? ''}/${b.metadata.name}`]
  return x < y ? -1 : x > y ? 1 : 0
}
// Labels and Annotations: the tags, or "None" where the drawer always shows the section
const tagSection = (m?: Record<string, string>) => (Object.keys(m ?? {}).length ? section({ tags: tagsOf(m) }) : section({ marks: ['None'] }))
const tagSectionsIfAny = (o: Obj) => ({
  ...(Object.keys(o.metadata.labels ?? {}).length ? { Labels: section({ tags: tagsOf(o.metadata.labels) }) } : {}),
  ...(Object.keys(o.metadata.annotations ?? {}).length ? { Annotations: section({ tags: tagsOf(o.metadata.annotations) }) } : {}),
})
// a pod's STATUS as kubectl get pods -A printed it in this round: the drawers' pod tables show that word, not the phase
let printedStatus: Record<string, string> = {}
const kubectlStatus = (p: Obj) => printedStatus[`${p.metadata.namespace}/${p.metadata.name}`] ?? dash(p.status.phase)
// a pod list of a drawer, in the API's order (namespace/name)
const podTable = (head: string[], pods: Obj[], cells: (p: Obj) => string[]): TableView[] =>
  [{ head, rows: [...pods].sort((a, b) => (`${a.metadata.namespace}/${a.metadata.name}` < `${b.metadata.namespace}/${b.metadata.name}` ? -1 : 1)).map(cells) }]
// a label selector as the webhook drawer lays it out (one chip per term) and as the admission policy drawer writes it
const selectorTerms = (s?: Obj) => [
  ...Object.entries(s?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`),
  ...(s?.matchExpressions ?? []).map((e: Obj) => `${e.key} ${e.operator} [${(e.values ?? []).join(', ')}]`),
]

type Ctx = { o: Obj; events: Obj[]; pods: Obj[]; nodes: Obj[]; bindings: Obj[]; roleBindings: Obj[] }
type Kind = { kind: string; plural: string; list: string; namespaced: boolean; names: string[]; want: (c: Ctx) => View }

// [webhook drawer] one webhook's section
function webhookSection(wh: Obj, mutating: boolean): Section {
  const cc = wh.clientConfig ?? {}
  const svc = cc.service
  const client: Record<string, string> = cc.url
    ? { 'Client Config (URL)': cc.url }
    : svc ? { 'Client Config (Service)': `${svc.namespace ?? ''}/${svc.name ?? '-'}${svc.path ? ` path: ${svc.path}` : ''}${svc.port ? ` port: ${svc.port}` : ''}` } : { 'Client Config': '-' }
  const rules: Obj[] = wh.rules ?? []
  const conditions: Obj[] = wh.matchConditions ?? []
  return section({
    rows: rowsOf({
      Name: dash(wh.name),
      'Admission Review Versions': (wh.admissionReviewVersions ?? []).join(', ') || '-',
      ...client,
      'Failure Policy': dash(wh.failurePolicy), 'Match Policy': dash(wh.matchPolicy), 'Side Effects': dash(wh.sideEffects),
      'Timeout Seconds': wh.timeoutSeconds ? String(wh.timeoutSeconds) : '-',
      ...(mutating && wh.reinvocationPolicy ? { 'Reinvocation Policy': wh.reinvocationPolicy } : {}),
      'Namespace Selector': selectorTerms(wh.namespaceSelector).join(' ') || '-',
      'Object Selector': selectorTerms(wh.objectSelector).join(' ') || '-',
      ...(rules.length ? {} : { Rules: '-' }),
    }),
    notes: [...(rules.length ? ['Rules'] : []), ...(conditions.length ? ['Match Conditions'] : [])],
    tables: rules.length ? [{
      head: ['API Groups', 'API Versions', 'Operations', 'Resources', 'Scope'],
      rows: rules.map((r) => [(r.apiGroups ?? []).map((g: string) => g || '""').join(', '), (r.apiVersions ?? []).join(', '), (r.operations ?? []).join(', '), (r.resources ?? []).join(', '), r.scope || '*']),
    }] : [],
    cards: conditions.map((c) => card({ '#': `${dash(c.name)} ${dash(c.expression)}` })),
  })
}

function webhookWant(c: Ctx, mutating: boolean): View {
  const { o } = c
  const webhooks: Obj[] = o.webhooks ?? []
  // every (group, resource) pair and operation of the rules — what the API server sends to the webhooks
  const resources = new Set<string>()
  const operations = new Set<string>()
  for (const wh of webhooks) {
    for (const r of wh.rules ?? []) {
      for (const g of (r.apiGroups ?? []).length ? r.apiGroups : ['']) for (const res of r.resources ?? []) resources.add(`${g || '""'}/${res}`)
      for (const op of r.operations ?? []) operations.add(op)
    }
  }
  const affected = [...resources].sort()
  const ops = [...operations].sort()
  return {
    badges: { Webhooks: String(webhooks.length), Type: mutating ? 'Mutating' : 'Validating' },
    counts: {},
    sections: {
      Summary: section({ rows: rowsOf({ Name: o.metadata.name, UID: o.metadata.uid, Created: at(o.metadata.creationTimestamp), 'Resource Version': o.metadata.resourceVersion }) }),
      ...Object.fromEntries(webhooks.map((wh) => [`Webhook: ${wh.name}`, webhookSection(wh, mutating)])),
      ...(webhooks.length ? {} : { Webhooks: section({ marks: ['-'] }) }),
      ...(affected.length ? { [`Affected Resources (${affected.length} kinds, ${ops.length} ops)`]: section({ notes: ['Resource Types (apiGroup/resource)', 'Operations'], chips: [...affected.slice(0, 50), ...ops], marks: pagerMarks(affected.length, 50) }) } : {}),
      Events: eventsSection(c.events),
      Labels: tagSection(o.metadata.labels),
      Annotations: tagSection(o.metadata.annotations),
    },
  }
}

// [admission policy drawer]
const policyRules = (rules: Obj[]): TableView => ({
  head: ['API Groups', 'API Versions', 'Operations', 'Resources', 'Resource Names', 'Scope'],
  rows: rules.map((r) => [(r.apiGroups ?? []).map((g: string) => g || '""').join(', '), (r.apiVersions ?? []).join(', '), (r.operations ?? []).join(', '), (r.resources ?? []).join(', '), (r.resourceNames ?? []).join(', ') || '-', r.scope || '*']),
})
const ruleText = (r: Obj) => `${(r.apiGroups ?? []).map((g: string) => g || '""').join(',')}/${(r.apiVersions ?? []).join(',')} ${(r.resources ?? []).join(',')} [${(r.operations ?? []).join(',')}]`
const paramRefText = (ref?: Obj) => {
  if (!ref) return '-'
  const name = ref.namespace ? `${ref.namespace}/${ref.name ?? ''}` : (ref.name ?? '')
  return `${name || selectorTerms(ref.selector).join(', ') || '-'}${ref.parameterNotFoundAction ? ` (${ref.parameterNotFoundAction})` : ''}`
}
const expressions = (items: { name?: string; expression?: string }[]) => items.map((i) => card({ '#': `${dash(i.name)} ${dash(i.expression)}` }))

function policyWant(c: Ctx, validating: boolean): View {
  const { o } = c
  const spec = o.spec ?? {}
  const match = spec.matchConstraints ?? {}
  const rules: Obj[] = match.resourceRules ?? []
  const exclude: Obj[] = match.excludeResourceRules ?? []
  const validations: Obj[] = spec.validations ?? []
  const mutations: Obj[] = spec.mutations ?? []
  const warnings: Obj[] = o.status?.typeChecking?.expressionWarnings ?? []
  const conditions: Obj[] = o.status?.conditions ?? []
  const fp = spec.failurePolicy ?? 'Fail'
  const count = validating ? validations.length : mutations.length
  return {
    badges: { [validating ? 'Validations' : 'Mutations']: String(count), Bindings: String(c.bindings.length), 'Failure Policy': fp },
    counts: {},
    sections: {
      Summary: section({
        rows: rowsOf({
          Name: o.metadata.name, UID: o.metadata.uid, Created: at(o.metadata.creationTimestamp), 'Resource Version': o.metadata.resourceVersion,
          'Failure Policy': fp, 'Param Kind': spec.paramKind ? `${spec.paramKind.apiVersion}/${spec.paramKind.kind}` : '-',
          ...(validating ? {} : { 'Reinvocation Policy': spec.reinvocationPolicy || 'Never' }),
          'Match Policy': match.matchPolicy || 'Equivalent',
        }),
      }),
      'Match Constraints': section({
        rows: rowsOf({
          'Namespace Selector': selectorTerms(match.namespaceSelector).join(', ') || '-',
          'Object Selector': selectorTerms(match.objectSelector).join(', ') || '-',
          ...(rules.length ? {} : { 'Resource Rules': '-' }),
        }),
        notes: [...(rules.length ? ['Resource Rules'] : []), ...(exclude.length ? ['Exclude Resource Rules'] : [])],
        tables: [...(rules.length ? [policyRules(rules)] : []), ...(exclude.length ? [policyRules(exclude)] : [])],
      }),
      ...((spec.matchConditions ?? []).length ? { 'Match Conditions': section({ cards: expressions(spec.matchConditions) }) } : {}),
      ...((spec.variables ?? []).length ? { Variables: section({ cards: expressions(spec.variables) }) } : {}),
      ...(validating
        ? {
          Validations: validations.length
            ? section({ cards: validations.map((v) => card({ '#': [dash(v.expression), v.message && `Message: ${v.message}`, v.messageExpression && `Message Expression: ${v.messageExpression}`, v.reason && `Reason: ${v.reason}`].filter(Boolean).join(' ') })) })
            : section({ marks: ['-'] }),
        }
        : {
          Mutations: mutations.length
            ? section({ cards: mutations.map((m) => card({ '#': `Patch Type: ${dash(m.patchType)} ${dash(m.applyConfiguration?.expression ?? m.jsonPatch?.expression)}` })) })
            : section({ marks: ['-'] }),
        }),
      ...((spec.auditAnnotations ?? []).length ? { 'Audit Annotations': section({ cards: expressions(spec.auditAnnotations.map((a: Obj) => ({ name: a.key, expression: a.valueExpression }))) }) } : {}),
      ...(warnings.length || conditions.length ? {
        'Type Checking': section({
          cards: warnings.map((w) => card({ '#': `${dash(w.fieldRef)} ${dash(w.warning)}` })),
          rows: Object.fromEntries(conditions.map((x) => [dash(x.type), [`${dash(x.status)}${x.reason ? ` · ${x.reason}` : ''}${x.message ? ` · ${x.message}` : ''}`]])),
        }),
      } : {}),
      // ten to a page (number-check-hidden-rows reads every page)
      Bindings: c.bindings.length
        ? section({
          marks: pagerMarks(c.bindings.length, 10),
          tables: [{
            head: ['Name', ...(validating ? ['Validation Actions'] : []), 'Param Ref', 'Namespace Selector', 'Resource Rules'],
            rows: c.bindings.slice(0, 10).map((b) => {
              const mr = b.spec?.matchResources ?? {}
              const brules: Obj[] = mr.resourceRules ?? []
              return [b.metadata.name, ...(validating ? [(b.spec?.validationActions ?? []).join(', ') || '-'] : []), paramRefText(b.spec?.paramRef),
                selectorTerms(mr.namespaceSelector).join(', ') || '-', brules.length ? brules.map(ruleText).join(' ') : '-']
            }),
          }],
        })
        : section({ marks: ['-'] }),
      Events: eventsSection(c.events),
      Labels: tagSection(o.metadata.labels),
      Annotations: tagSection(o.metadata.annotations),
    },
  }
}

// [lease drawer] the holder state by the API server's own rule (isLeaseExpired: no renew time or duration, or renewTime
// + leaseDurationSeconds before now, is expired)
function leaseWant(c: Ctx): View {
  const { o } = c
  const spec = o.spec ?? {}
  const duration: number | undefined = spec.leaseDurationSeconds
  const renewed = spec.renewTime ? Date.parse(spec.renewTime) : NaN
  const expiresAt = !Number.isNaN(renewed) && duration != null ? renewed + duration * 1000 : NaN
  const holder = !spec.holderIdentity ? 'None' : Number.isNaN(expiresAt) || expiresAt < Date.now() ? 'Expired' : 'Active'
  const until = Number.isNaN(expiresAt) ? undefined : new Date(expiresAt).toISOString()
  return {
    badges: {
      Holder: holder,
      ...(duration != null ? { 'Lease Time': `${duration}s` } : {}),
      ...(spec.leaseTransitions != null ? { Transitions: String(spec.leaseTransitions) } : {}),
    },
    counts: {},
    sections: {
      Summary: section({ rows: rowsOf({ Name: o.metadata.name, Namespace: o.metadata.namespace, UID: o.metadata.uid, Created: at(o.metadata.creationTimestamp) }) }),
      'Lease Spec': section({
        rows: rowsOf({
          'Holder Identity': dash(spec.holderIdentity),
          'Lease Duration': duration != null ? `${duration}s` : '-',
          'Lease Transitions': spec.leaseTransitions != null ? String(spec.leaseTransitions) : '-',
          'Renew Time': at(spec.renewTime), 'Acquire Time': at(spec.acquireTime),
          ...(spec.acquireTime ? { 'Lease Age': at(spec.acquireTime) } : {}),
          ...(until ? { 'Expires In': `${expiresAt < Date.now() ? '<' : '>'}${until}` } : {}),
        }),
      }),
      Events: eventsSection(c.events),
      Labels: tagSection(o.metadata.labels),
      Annotations: tagSection(o.metadata.annotations),
    },
  }
}

const KINDS: Kind[] = [
  {
    kind: 'ClusterRole', plural: 'clusterroles', list: '/security/clusterroles', namespaced: false, names: ['rbacd-plain', 'rbacd-agg'],
    want: (c) => {
      const { o } = c
      const rules: Obj[] = o.rules ?? []
      const selectors: Obj[] = o.aggregationRule?.clusterRoleSelectors ?? []
      const exprText = (e: Obj) => `${e.key} ${e.operator} [${(e.values ?? []).join(', ')}]`
      const labelTerms = (s: Obj) => Object.entries(s.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`)
      return {
        badges: {},
        counts: { 'Referenced By ClusterRoleBindings': c.bindings.length, 'Referenced By RoleBindings': c.roleBindings.length },
        sections: {
          'Basic Info': section({ rows: rowsOf({ Kind: 'ClusterRole', Name: o.metadata.name, Created: at(o.metadata.creationTimestamp), UID: o.metadata.uid, 'Resource Version': o.metadata.resourceVersion, 'Rules Count': String(rules.length) }) }),
          ...(selectors.length ? {
            'Aggregation Rule': section({
              cards: selectors.map((s) => card({
                'Match Labels': labelTerms(s).join(' ') || '-',
                ...((s.matchExpressions ?? []).length ? { 'Match Expressions': s.matchExpressions.map(exprText).join(' ') } : {}),
              })),
              chips: selectors.flatMap((s) => [...labelTerms(s), ...(s.matchExpressions ?? []).map(exprText)]),
            }),
          } : {}),
          ...(rules.length ? {
            Rules: section({
              cards: rules.map((r) => card({
                'API Groups': (r.apiGroups ?? []).length ? r.apiGroups.map((g: string) => g || '""').join(', ') : '-',
                Resources: (r.resources ?? []).join(', ') || '-',
                Verbs: (r.verbs ?? []).join(' '),
                ...((r.resourceNames ?? []).length ? { 'Resource Names': r.resourceNames.join(', ') } : {}),
                ...((r.nonResourceURLs ?? []).length ? { 'Non-Resource URLs': r.nonResourceURLs.join(', ') } : {}),
              })),
              chips: rules.flatMap((r) => r.verbs ?? []),
            }),
          } : {}),
          'Referenced By ClusterRoleBindings': c.bindings.length
            ? section({ tables: [{ head: ['ClusterRoleBinding', 'Subjects'], rows: c.bindings.slice(0, 10).map((b) => [b.metadata.name, subjectsText(b)]) }], marks: pagerMarks(c.bindings.length, 10) })
            : section({ notes: ['No ClusterRoleBinding references this ClusterRole.'] }),
          // `kubectl get rolebindings -A` whose ROLE is ClusterRole/<name> (RBAC: a RoleBinding can reference a ClusterRole)
          'Referenced By RoleBindings': c.roleBindings.length
            ? section({ tables: [{ head: ['Namespace', 'RoleBinding', 'Subjects'], rows: c.roleBindings.slice(0, 10).map((b) => [b.metadata.namespace, b.metadata.name, subjectsText(b)]) }], marks: pagerMarks(c.roleBindings.length, 10) })
            : section({ notes: ['No RoleBinding references this ClusterRole.'] }),
          ...tagSectionsIfAny(o),
          Events: eventsSection(c.events),
        },
      }
    },
  },
  {
    kind: 'ClusterRoleBinding', plural: 'clusterrolebindings', list: '/security/clusterrolebindings', namespaced: false, names: ['rbacd-crb-a', 'rbacd-crb-b', 'rbacd-crb-empty'],
    want: (c) => {
      const { o } = c
      const subjects: Obj[] = o.subjects ?? []
      const sa = subjects.filter((s) => s.kind === 'ServiceAccount' && s.namespace && s.name)
      const kinds: Record<string, number> = {}
      for (const s of subjects) kinds[s.kind || 'Unknown'] = (kinds[s.kind || 'Unknown'] ?? 0) + 1
      return {
        badges: {},
        counts: { ...(subjects.length ? { Subjects: subjects.length } : {}), ...(sa.length ? { 'Bound Pods via ServiceAccount Subjects': c.pods.length } : {}) },
        sections: {
          'Basic Info': section({ rows: rowsOf({ Kind: 'ClusterRoleBinding', Name: o.metadata.name, Created: at(o.metadata.creationTimestamp), UID: o.metadata.uid, 'Resource Version': o.metadata.resourceVersion }) }),
          'Role Reference': section({ rows: rowsOf({ Kind: dash(o.roleRef.kind), Name: dash(o.roleRef.name), 'API Group': dash(o.roleRef.apiGroup) }) }),
          // the kinds counted over every subject, the subjects ten to a page (number-check-hidden-rows reads every page)
          Subjects: subjects.length
            ? section({
              chips: Object.entries(kinds).map(([k, n]) => `${k}: ${n}`),
              cards: subjects.slice(0, 10).map((s) => card({ Kind: dash(s.kind), Name: dash(s.name), ...(s.namespace ? { Namespace: s.namespace } : {}), ...(s.apiGroup ? { 'API Group': s.apiGroup } : {}) })),
              marks: pagerMarks(subjects.length, 10),
            })
            : section({ notes: ['No subjects defined.'] }),
          ...(sa.length ? {
            'Bound Pods via ServiceAccount Subjects': c.pods.length
              ? section({ tables: podTable(['Namespace', 'Pod', 'SA', 'Status'], c.pods, (p) => [p.metadata.namespace, p.metadata.name, p.spec.serviceAccountName, kubectlStatus(p)]) })
              : section({ notes: ['No pod uses any of the bound ServiceAccounts.'] }),
          } : {}),
          ...tagSectionsIfAny(o),
          Events: eventsSection(c.events),
        },
      }
    },
  },
  {
    kind: 'PriorityClass', plural: 'priorityclasses', list: '/cluster/priorityclasses', namespaced: false, names: ['rbacd-pc', 'rbacd-pc-plain'],
    want: (c) => {
      const { o } = c
      const preemption = o.preemptionPolicy ?? 'PreemptLowerPriority'
      const yesNo = o.globalDefault ? 'Yes' : 'No'
      return {
        // the policy as the API writes it, as kubectl describe prints it (unset: the API default)
        badges: { Value: String(o.value), 'Global Default': yesNo, Preemption: preemption },
        counts: { 'Used By Pods': c.pods.length },
        sections: {
          Summary: section({ rows: rowsOf({ Name: o.metadata.name, UID: o.metadata.uid, Created: at(o.metadata.creationTimestamp) }) }),
          'Priority Settings': section({ rows: rowsOf({ Value: String(o.value), 'Global Default': yesNo, 'Preemption Policy': preemption }) }),
          'Used By Pods': c.pods.length
            ? section({ tables: podTable(['Namespace', 'Pod', 'Status', 'Node', 'Age'], c.pods, (p) => [p.metadata.namespace, p.metadata.name, kubectlStatus(p), dash(p.spec.nodeName), at(p.metadata.creationTimestamp)]) })
            : section({ notes: ['No pod in the cluster uses this PriorityClass.'] }),
          Description: section({ marks: [dash(o.description)] }),
          Events: eventsSection(c.events),
          Labels: tagSection(o.metadata.labels),
          Annotations: tagSection(o.metadata.annotations),
        },
      }
    },
  },
  {
    kind: 'RuntimeClass', plural: 'runtimeclasses', list: '/cluster/runtimeclasses', namespaced: false, names: ['rbacd-rc', 'rbacd-rc-plain'],
    want: (c) => {
      const { o } = c
      const overhead: Record<string, string> = o.overhead?.podFixed ?? {}
      const scheduling = o.scheduling ?? {}
      const nodeSelector: Record<string, string> = scheduling.nodeSelector ?? {}
      const tolerations: Obj[] = scheduling.tolerations ?? []
      const hasScheduling = Object.keys(nodeSelector).length > 0 || tolerations.length > 0
      // `kubectl get nodes -l <nodeSelector>`
      const matching = c.nodes.filter((n) => Object.entries(nodeSelector).every(([k, v]) => n.metadata.labels?.[k] === v))
      return {
        badges: { Handler: dash(o.handler), Overhead: Object.keys(overhead).length ? 'Configured' : '-', Scheduling: hasScheduling ? 'Configured' : '-' },
        // the nodes whose labels match scheduling.nodeSelector (taints and cordon are not part of it)
        counts: { ...(Object.keys(nodeSelector).length ? { [NODES_MATCHING]: matching.length } : {}), 'Used By Pods': c.pods.length },
        sections: {
          Summary: section({ rows: rowsOf({ Name: o.metadata.name, UID: o.metadata.uid, Created: at(o.metadata.creationTimestamp) }) }),
          'Runtime Settings': section({ rows: rowsOf({ Handler: dash(o.handler) }) }),
          ...(Object.keys(overhead).length ? { Overhead: section({ rows: rowsOf(Object.fromEntries(Object.entries(overhead).sort(([a], [b]) => (a < b ? -1 : 1)))) }) } : {}),
          ...(hasScheduling ? {
            Scheduling: section({
              notes: [...(Object.keys(nodeSelector).length ? ['Node Selector'] : []), ...(tolerations.length ? ['Tolerations'] : [])],
              tags: tagsOf(nodeSelector),
              marks: tolerations.map((t) => `${t.key ?? ''}${t.operator === 'Equal' ? `=${t.value ?? ''}` : ''} : ${t.effect || '*'}${t.tolerationSeconds != null ? ` (${t.tolerationSeconds}s)` : ''}`),
            }),
          } : {}),
          ...(Object.keys(nodeSelector).length ? {
            [NODES_MATCHING]: matching.length ? section({ marks: [...matching.slice(0, 20).map((n) => n.metadata.name), ...pagerMarks(matching.length, 20)] }) : section({ notes: ['No Node matches scheduling.nodeSelector.'] }),
          } : {}),
          'Used By Pods': c.pods.length
            ? section({ tables: podTable(['Namespace', 'Pod', 'Status', 'Node'], c.pods, (p) => [p.metadata.namespace, p.metadata.name, kubectlStatus(p), dash(p.spec.nodeName)]) })
            : section({ notes: ['No pod in the cluster uses this RuntimeClass.'] }),
          Events: eventsSection(c.events),
          Labels: tagSection(o.metadata.labels),
          Annotations: tagSection(o.metadata.annotations),
        },
      }
    },
  },
  { kind: 'Lease', plural: 'leases', list: '/cluster/leases', namespaced: true, names: ['rbacd-active', 'rbacd-expired', 'rbacd-norenew', 'rbacd-free'], want: leaseWant },
  { kind: 'ValidatingWebhookConfiguration', plural: 'validatingwebhookconfigurations', list: '/cluster/validatingwebhookconfigurations', namespaced: false, names: ['rbacd-vwc'], want: (c) => webhookWant(c, false) },
  { kind: 'MutatingWebhookConfiguration', plural: 'mutatingwebhookconfigurations', list: '/cluster/mutatingwebhookconfigurations', namespaced: false, names: ['rbacd-mwc'], want: (c) => webhookWant(c, true) },
  { kind: 'ValidatingAdmissionPolicy', plural: 'validatingadmissionpolicies', list: '/cluster/validatingadmissionpolicies', namespaced: false, names: ['rbacd-vap'], want: (c) => policyWant(c, true) },
  { kind: 'MutatingAdmissionPolicy', plural: 'mutatingadmissionpolicies', list: '/cluster/mutatingadmissionpolicies', namespaced: false, names: ['rbacd-map'], want: (c) => policyWant(c, false) },
]

// Leases of known times, as a holder would leave them: renewed within its duration, run out, never renewed, free
// (seconds before the run: renewed, acquired)
const LEASES: { name: string; spec: Obj }[] = [
  { name: 'rbacd-active', spec: { holderIdentity: 'rbacd-holder-1', leaseDurationSeconds: 3600, leaseTransitions: 3, renew: 60, acquire: 300 } },
  { name: 'rbacd-expired', spec: { holderIdentity: 'rbacd-holder-2', leaseDurationSeconds: 30, leaseTransitions: 1, renew: 600, acquire: 900 } },
  { name: 'rbacd-norenew', spec: { holderIdentity: 'rbacd-holder-3', leaseDurationSeconds: 37, leaseTransitions: 0 } },
  { name: 'rbacd-free', spec: {} },
]
// a MicroTime as the API reads it: RFC 3339 with six fraction digits
const microAgo = (s: number) => `${new Date(Date.now() - s * 1000).toISOString().slice(0, 19)}.000000Z`
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString().replace(/\.\d+Z$/, 'Z')

// events about the objects as a controller records them — a Lease's in its namespace, a cluster-scoped object's in
// default (the API server takes an event with no involvedObject.namespace only there): a Warning seen twice, one about
// a ClusterRoleBinding of a ClusterRole's name (the ClusterRole's drawer leaves it out).
// [kind, name, reason, type, count, last seen and first seen, seconds ago]
const EVENTS: [string, string, string, string, number, number, number][] = [
  ['ClusterRole', 'rbacd-plain', 'RbacdSeen', 'Normal', 1, 120, 120],
  ['ClusterRoleBinding', 'rbacd-plain', 'RbacdElsewhere', 'Normal', 1, 30, 30],
  ['ClusterRoleBinding', 'rbacd-crb-a', 'RbacdBound', 'Warning', 2, 60, 600],
  ['PriorityClass', 'rbacd-pc', 'RbacdUsed', 'Normal', 1, 90, 90],
  ['RuntimeClass', 'rbacd-rc', 'RbacdHandled', 'Normal', 1, 45, 45],
  ['Lease', 'rbacd-expired', 'RbacdExpired', 'Warning', 3, 200, 1200],
  ['ValidatingWebhookConfiguration', 'rbacd-vwc', 'RbacdCalled', 'Normal', 1, 75, 75],
  ['MutatingWebhookConfiguration', 'rbacd-mwc', 'RbacdMutated', 'Normal', 1, 80, 80],
  ['ValidatingAdmissionPolicy', 'rbacd-vap', 'RbacdTypeChecked', 'Normal', 1, 150, 150],
  ['MutatingAdmissionPolicy', 'rbacd-map', 'RbacdMutated', 'Normal', 2, 40, 400],
]
const eventNamespace = (kind: string) => (kind === 'Lease' ? NS : 'default')
const eventName = (kind: string, name: string, reason: string) => `${name}.${reason.toLowerCase()}.${kind.toLowerCase()}`
const API_VERSION: Record<string, string> = {
  ClusterRole: 'rbac.authorization.k8s.io/v1', ClusterRoleBinding: 'rbac.authorization.k8s.io/v1', PriorityClass: 'scheduling.k8s.io/v1',
  RuntimeClass: 'node.k8s.io/v1', Lease: 'coordination.k8s.io/v1', ValidatingWebhookConfiguration: 'admissionregistration.k8s.io/v1',
  MutatingWebhookConfiguration: 'admissionregistration.k8s.io/v1', ValidatingAdmissionPolicy: 'admissionregistration.k8s.io/v1',
  MutatingAdmissionPolicy: 'admissionregistration.k8s.io/v1',
}
// the cluster-scoped objects of the fixture, by kind
const CLUSTER_OBJECTS = [
  'clusterrole/rbacd-plain', 'clusterrole/rbacd-part', 'clusterrole/rbacd-agg', 'clusterrolebinding/rbacd-crb-a', 'clusterrolebinding/rbacd-crb-b',
  'clusterrolebinding/rbacd-crb-empty', 'priorityclass/rbacd-pc', 'priorityclass/rbacd-pc-plain', 'runtimeclass/rbacd-rc', 'runtimeclass/rbacd-rc-plain',
  'validatingwebhookconfiguration/rbacd-vwc', 'mutatingwebhookconfiguration/rbacd-mwc', 'validatingadmissionpolicybinding/rbacd-vap-b',
  'validatingadmissionpolicy/rbacd-vap', 'mutatingadmissionpolicy/rbacd-map',
]

test.describe('number check — cluster configuration, RBAC and admission drawers', () => {
  test('every drawer of the nine kinds shows the numbers the cluster has, opened from its list and by link', async ({ page }) => {
    test.setTimeout(900_000)
    const kubectl = selfKubectl()
    const served = kubectl ? kubectl('api-resources --api-group=admissionregistration.k8s.io -o name') : ''
    test.skip(!kubectl || !/^mutatingadmissionpolicies\b/m.test(served) || !/^validatingadmissionpolicies\b/m.test(served),
      'needs the kind cluster kubeast (self) serving admissionregistration.k8s.io/v1 admission policies (Kubernetes 1.36+)')
    const k = kubectl!
    const kindOf = (kind: string) => KINDS.find((x) => x.kind === kind)!
    const get = (kind: string, name: string): Obj => {
      const x = kindOf(kind)
      return JSON.parse(k(`get ${x.plural} ${name}${x.namespaced ? ` -n ${NS}` : ''} -o json`))
    }
    // gone, not terminating, before and after: the namespace (its pods, leases and events), the cluster-scoped objects
    // and their events in default
    const cleanup = () => {
      k(`delete namespace ${NS} --wait=true --timeout=180s --ignore-not-found`)
      k(`delete ${CLUSTER_OBJECTS.join(' ')} --ignore-not-found --wait=true`)
      const defaultEvents = EVENTS.filter(([kind]) => eventNamespace(kind) === 'default').map(([kind, name, reason]) => eventName(kind, name, reason))
      k(`delete events -n default ${defaultEvents.join(' ')} --ignore-not-found`)
    }
    cleanup()
    try {
      // the pods after the rest: the priority admission plugin finds a PriorityClass in its informer, which may not
      // have the one made a moment before
      const docs = FIXTURE.split(/^---$/m)
      const isPod = (d: string) => /^kind: Pod$/m.test(d)
      k('apply --server-side --field-manager=e2e-rbac-drawers -f -', docs.filter((d) => !isPod(d)).join('---'))
      await expect.poll(() => {
        try {
          k('apply --server-side --field-manager=e2e-rbac-drawers -f -', docs.filter(isPod).join('---'))
          return 'made'
        } catch (e) {
          return String((e as { stderr?: string }).stderr ?? e)
        }
      }, { timeout: 30_000, intervals: [1_000] }).toBe('made')
      k(`wait --for=condition=Ready pod --all -n ${NS} --timeout=180s`)
      const leases = LEASES.map(({ name, spec: { renew, acquire, ...spec } }) => ({
        apiVersion: 'coordination.k8s.io/v1', kind: 'Lease',
        metadata: { name, namespace: NS, ...(name === 'rbacd-active' ? { labels: { 'rbacd.kubeast.io/kind': 'lease' } } : {}) },
        spec: { ...spec, ...(renew != null ? { renewTime: microAgo(renew) } : {}), ...(acquire != null ? { acquireTime: microAgo(acquire) } : {}) },
      }))
      k('apply --server-side --field-manager=e2e-rbac-drawers -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: leases }))
      // the aggregation controller has filled rbacd-agg (rbacd-plain's two rules and rbacd-part's one), and the type
      // checker has looked at the policy, before the drawers are read
      await expect.poll(() => (get('ClusterRole', 'rbacd-agg').rules ?? []).length, { timeout: 60_000 }).toBe(3)
      for (let i = 0; i < 30; i++) {
        const p = get('ValidatingAdmissionPolicy', 'rbacd-vap')
        if (p.status?.observedGeneration === p.metadata.generation) break
        await page.waitForTimeout(2_000)
      }
      const items = EVENTS.map(([kind, name, reason, type, count, last, first]) => {
        let uid: string | undefined
        try {
          uid = get(kind, name).metadata.uid
        } catch {
          uid = undefined
        }
        return {
          apiVersion: 'v1', kind: 'Event',
          metadata: { name: eventName(kind, name, reason), namespace: eventNamespace(kind) },
          involvedObject: { apiVersion: API_VERSION[kind], kind, name, ...(kind === 'Lease' ? { namespace: NS } : {}), ...(uid ? { uid } : {}) },
          reason, message: `${reason} by the number check`, type, count, firstTimestamp: ago(first), lastTimestamp: ago(last),
          source: { component: 'e2e-rbac-drawers' },
        }
      })
      k('create -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items }))

      // the object, the events kubectl describe lists about it (its name, kind and uid), the pods, nodes and bindings
      // its drawer counts
      const clusterOf = (x: Kind, name: string): Ctx => {
        const o = get(x.kind, name)
        const events = JSON.parse(k(`get events -A --field-selector involvedObject.name=${name},involvedObject.kind=${x.kind} -o json`)).items
          .filter((e: Obj) => e.involvedObject.uid === o.metadata.uid)
          .sort((a: Obj, b: Obj) => Date.parse(b.lastTimestamp ?? b.firstTimestamp) - Date.parse(a.lastTimestamp ?? a.firstTimestamp))
        const allPods: Obj[] = ['ClusterRoleBinding', 'PriorityClass', 'RuntimeClass'].includes(x.kind) ? JSON.parse(k('get pods -A -o json')).items : []
        if (allPods.length) {
          printedStatus = Object.fromEntries(k('get pods -A --no-headers').split('\n').filter(Boolean).map((line) => {
            const [namespace, pod, , status] = line.trim().split(/\s+/)
            return [`${namespace}/${pod}`, status]
          }))
        }
        const saOf = (p: Obj) => `${p.metadata.namespace}/${p.spec.serviceAccountName || 'default'}`
        const pods = x.kind === 'PriorityClass' ? allPods.filter((p) => p.spec.priorityClassName === name)
          : x.kind === 'RuntimeClass' ? allPods.filter((p) => p.spec.runtimeClassName === name)
            : x.kind === 'ClusterRoleBinding' ? allPods.filter((p) => (o.subjects ?? []).some((s: Obj) => s.kind === 'ServiceAccount' && `${s.namespace}/${s.name}` === saOf(p)))
              : []
        const nodes: Obj[] = x.kind === 'RuntimeClass' ? JSON.parse(k('get nodes -o json')).items : []
        // a ClusterRole's ClusterRoleBindings (roleRef), a policy's bindings (spec.policyName), by name
        const bindings: Obj[] = x.kind === 'ClusterRole'
          ? JSON.parse(k('get clusterrolebindings -o json')).items.filter((b: Obj) => b.roleRef.kind === 'ClusterRole' && b.roleRef.name === name)
          : x.kind.endsWith('AdmissionPolicy')
            ? JSON.parse(k(`get ${x.plural.replace(/ies$/, 'ybindings')} -o json`)).items.filter((b: Obj) => b.spec?.policyName === name)
            : []
        bindings.sort((a, b) => (a.metadata.name < b.metadata.name ? -1 : 1))
        // a ClusterRole's RoleBindings of every namespace (roleRef kind and name — not a Role of the same name)
        const roleBindings: Obj[] = x.kind === 'ClusterRole'
          ? JSON.parse(k('get rolebindings -A -o json')).items.filter((b: Obj) => b.roleRef.kind === 'ClusterRole' && b.roleRef.name === name).sort(byKey)
          : []
        return { o, events, pods, nodes, bindings, roleBindings }
      }
      const open = async (x: Kind, name: string, way: string) => {
        if (way === 'link') {
          await page.goto(`/?cluster=${CLUSTER}&detail=${encodeURIComponent(x.namespaced ? `${x.kind}/${NS}/${name}` : `${x.kind}/${name}`)}`)
        } else {
          await page.goto(`${x.list}?cluster=${CLUSTER}${x.namespaced ? `&namespace=${NS}` : ''}`)
          // the list's search box, then the row's name cell (the names here have no regular expression characters)
          await page.locator('main input.h-12').first().fill(name)
          const exact = { hasText: new RegExp(`^\\s*${name}\\s*$`) }
          await page.locator('main tbody tr').filter({ has: page.locator('td', exact) }).first().locator('td', exact).click({ timeout: 20_000 })
        }
        await page.locator(DRAWER).last().waitFor({ timeout: 20_000 })
      }

      for (const x of KINDS) {
        for (const name of x.names) {
          for (const way of ['list', 'link']) {
            await test.step(`${x.kind}/${name} · ${way}`, async () => {
              const want = x.want(clusterOf(x, name))
              await open(x, name, way)
              const shown = async () => settle(await readDrawer(page), want)
              try {
                await expect.poll(shown, { timeout: 20_000 }).toEqual(want)
              } catch {
                expect.soft(await shown(), `${x.kind}/${name} opened by ${way}`).toEqual(want)
              }
            })
          }
        }
      }
    } finally {
      cleanup()
    }
  })

  // a cluster that does not serve admissionregistration.k8s.io/v1 policies (before 1.30 for VAP, 1.36 for MAP, or the
  // API turned off): the server answers the list empty with X-Kubeast-Not-Installed (ListIfServed) and the page says
  // the cluster does not serve the kind — a built-in API, not a missing CRD — the answer stood in for here; a CRD-backed
  // kind self does not have (VerticalPodAutoscaler, the real answer) keeps the CRD text
  test('a cluster without the admission policy API says it does not serve the kind, a missing CRD says not installed', async ({ page }) => {
    await page.route((u) => /\/api\/v1\/cluster\/(validating|mutating)admissionpolicies$/.test(u.pathname), (route) => {
      const resource = /\/cluster\/(\w+)$/.exec(new URL(route.request().url()).pathname)![1]
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'X-Kubeast-Not-Installed': resource }, body: '[]' })
    })
    await page.routeWebSocket(/wsMultiplexer/, () => {})
    const notServed = '{{resource}} is not served by this cluster (a built-in Kubernetes API that its version does not have or that is turned off).'
    for (const [p, kind] of [['/cluster/validatingadmissionpolicies', 'ValidatingAdmissionPolicy'], ['/cluster/mutatingadmissionpolicies', 'MutatingAdmissionPolicy']]) {
      await page.goto(`${p}?cluster=${CLUSTER}`)
      await expect(page.getByTestId('table-not-installed'), p).toHaveText(notServed.replace('{{resource}}', kind), { timeout: 20_000 })
    }
    // self has no VPA CRD (notices.spec.ts holds that)
    await page.goto(`/workloads/vpas?cluster=${CLUSTER}`)
    await expect(page.getByTestId('table-not-installed')).toHaveText('{{resource}} is not installed on this cluster (no CustomResourceDefinition).'.replace('{{resource}}', 'VerticalPodAutoscaler'), { timeout: 20_000 })
  })
})
