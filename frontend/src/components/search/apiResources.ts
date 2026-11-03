import type { ResourceTypeOption } from './ResourceTypePicker'

interface APIResourceList {
  groupVersion?: string
  resources?: Array<{ name?: string; kind?: string; namespaced?: boolean; verbs?: string[] }>
}

// The type a picker entry is searched as (`resource_type`): its name, or name.group when another group serves the
// same name — the server resolves a bare name to one group (core first), so core Events and events.k8s.io Events, or
// two groups' widgets, are two entries and two lists. The core group keeps the bare name.
export function withSearchTypes(options: ResourceTypeOption[]): (ResourceTypeOption & { type: string })[] {
  const groups = new Map<string, Set<string>>()
  for (const o of options) groups.set(o.name, (groups.get(o.name) ?? new Set<string>()).add(o.group))
  const seen = new Set<string>()
  const out: (ResourceTypeOption & { type: string })[] = []
  for (const o of options) {
    const type = o.group === 'core' || groups.get(o.name)!.size === 1 ? o.name : `${o.name}.${o.group}`
    if (seen.has(type)) continue
    seen.add(type)
    out.push({ ...o, type })
  }
  return out
}

// /cluster/api-resources answers discovery's lists ({groupVersion, resources}),
// one per group version with each group's preferred version first. Subresources
// (pods/log) are skipped and a resource served in several versions is kept once.
export function flattenApiResources(lists: APIResourceList[]): ResourceTypeOption[] {
  const seen = new Set<string>()
  const out: ResourceTypeOption[] = []
  for (const list of lists) {
    const gv = list?.groupVersion ?? ''
    const group = gv.includes('/') ? gv.split('/')[0] : 'core'
    for (const r of list?.resources ?? []) {
      if (!r?.name || !r.kind || r.name.includes('/')) continue
      const key = `${group}/${r.name}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ name: r.name, kind: r.kind, group, namespaced: r.namespaced ?? true, verbs: r.verbs ?? [] })
    }
  }
  return out
}
