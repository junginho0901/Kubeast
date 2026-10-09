import type { ResourceTypeOption } from './ResourceTypePicker'

interface APIResourceList {
  groupVersion?: string
  resources?: Array<{ name?: string; kind?: string; namespaced?: boolean; verbs?: string[] }>
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
