import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Check, Search } from 'lucide-react'

export interface ResourceTypeOption {
  name: string
  kind: string
  group: string
  namespaced: boolean
  verbs?: string[]
}

const BUILTIN_RESOURCES: ResourceTypeOption[] = [
  { name: 'pods', kind: 'Pod', group: 'core', namespaced: true },
  { name: 'services', kind: 'Service', group: 'core', namespaced: true },
  { name: 'deployments', kind: 'Deployment', group: 'apps', namespaced: true },
  { name: 'replicasets', kind: 'ReplicaSet', group: 'apps', namespaced: true },
  { name: 'statefulsets', kind: 'StatefulSet', group: 'apps', namespaced: true },
  { name: 'daemonsets', kind: 'DaemonSet', group: 'apps', namespaced: true },
  { name: 'jobs', kind: 'Job', group: 'batch', namespaced: true },
  { name: 'cronjobs', kind: 'CronJob', group: 'batch', namespaced: true },
  { name: 'configmaps', kind: 'ConfigMap', group: 'core', namespaced: true },
  { name: 'secrets', kind: 'Secret', group: 'core', namespaced: true },
  { name: 'ingresses', kind: 'Ingress', group: 'networking.k8s.io', namespaced: true },
  { name: 'networkpolicies', kind: 'NetworkPolicy', group: 'networking.k8s.io', namespaced: true },
  { name: 'persistentvolumeclaims', kind: 'PersistentVolumeClaim', group: 'core', namespaced: true },
  { name: 'nodes', kind: 'Node', group: 'core', namespaced: false },
  { name: 'namespaces', kind: 'Namespace', group: 'core', namespaced: false },
  { name: 'persistentvolumes', kind: 'PersistentVolume', group: 'core', namespaced: false },
]

export const NON_LISTABLE = new Set([
  'bindings', 'localsubjectaccessreviews', 'selfsubjectaccessreviews',
  'selfsubjectrulesreviews', 'subjectaccessreviews', 'tokenreviews',
  'localresourceaccessreviews', 'resourceaccessreviews',
  'tokenrequests', 'selfsubjectreviews',
])

const GROUPS = ['core', 'apps', 'batch', 'networking.k8s.io']

interface Props {
  selected: Set<string>
  onChange: (selected: Set<string>) => void
  extraResources?: ResourceTypeOption[]
}

export default function ResourceTypePicker({ selected, onChange, extraResources }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')

  const allResources = useMemo(() => {
    const extra = extraResources ?? []
    const seen = new Set(BUILTIN_RESOURCES.map(r => r.name))
    const deduped = extra.filter(r => {
      if (seen.has(r.name) || NON_LISTABLE.has(r.name)) return false
      if (r.verbs && !r.verbs.includes('list')) return false
      seen.add(r.name)
      return true
    })
    return [...BUILTIN_RESOURCES, ...deduped]
  }, [extraResources])

  const filtered = useMemo(() => {
    if (!filter.trim()) return allResources
    const q = filter.toLowerCase()
    return allResources.filter(r =>
      r.kind.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || r.group.toLowerCase().includes(q)
    )
  }, [allResources, filter])

  const grouped = useMemo(() => {
    const map = new Map<string, ResourceTypeOption[]>()
    for (const r of filtered) {
      const g = r.group || 'core'
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(r)
    }
    const sorted = [...map.entries()].sort((a, b) => {
      const ai = GROUPS.indexOf(a[0])
      const bi = GROUPS.indexOf(b[0])
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
    })
    return sorted
  }, [filtered])

  const toggle = (name: string) => {
    const next = new Set(selected)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    onChange(next)
  }

  const selectAll = () => onChange(new Set(filtered.map(r => r.name)))
  const clearAll = () => onChange(new Set())

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium transition-colors"
      >
        <Search className="w-4 h-4 text-slate-400" />
        {t('advancedSearch.selectResources', 'Select Resources')}
        {selected.size > 0 && (
          <span className="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-sky-500/20 text-sky-400">
            {selected.size}
          </span>
        )}
        <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-2 z-50 w-80 max-h-[70vh] bg-slate-800 border border-slate-600 rounded-xl shadow-2xl overflow-hidden flex flex-col">
            <div className="p-3 border-b border-slate-700">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  placeholder={t('advancedSearch.filterResources', 'Filter resources...')}
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 rounded-lg bg-slate-900 border border-slate-600 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-sky-500"
                  autoFocus
                />
              </div>
              <div className="flex gap-2 mt-2">
                <button onClick={selectAll} className="flex-1 text-xs py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors">
                  {t('advancedSearch.selectAll', 'Select All')}
                </button>
                <button onClick={clearAll} className="flex-1 text-xs py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors">
                  {t('advancedSearch.clearAll', 'Clear All')}
                </button>
              </div>
            </div>
            <div className="overflow-y-auto p-2 space-y-1">
              {grouped.map(([group, resources]) => (
                <div key={group}>
                  <div className="px-2 py-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    {group}
                  </div>
                  {resources.map(r => {
                    const checked = selected.has(r.name)
                    return (
                      <button
                        key={r.name}
                        onClick={() => toggle(r.name)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                          checked ? 'bg-sky-500/10 text-sky-300' : 'text-slate-300 hover:bg-slate-700'
                        }`}
                      >
                        <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                          checked ? 'bg-sky-500 border-sky-500' : 'border-slate-500'
                        }`}>
                          {checked && <Check className="w-3 h-3 text-white" />}
                        </div>
                        <span className="font-medium">{r.kind}</span>
                        {!r.namespaced && (
                          <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">
                            cluster
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
