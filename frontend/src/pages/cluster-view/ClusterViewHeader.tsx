import { Search, X } from 'lucide-react'
import { useClusterView } from './ClusterViewContext'
import { NamespaceDropdown } from './NamespaceDropdown'

interface Props {
  namespaces: { name: string }[] | undefined
}

// title / subtitle + 검색 input + NamespaceDropdown.

export function ClusterViewHeader({ namespaces }: Props) {
  const { tr, searchQuery, setSearchQuery } = useClusterView()

  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-3xl font-bold text-white">{tr('clusterView.title', 'Cluster view')}</h1>
        <p className="mt-2 text-slate-400">
          {tr('clusterView.subtitle', 'Review pod placement across nodes')}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder={tr('clusterView.searchPlaceholder', 'Search pod name...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-10 pl-10 pr-4 bg-slate-700 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors w-64"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 hover:bg-slate-600 rounded transition-colors"
            >
              <X className="w-4 h-4 text-slate-400" />
            </button>
          )}
        </div>
        <NamespaceDropdown namespaces={namespaces} />
      </div>
    </div>
  )
}
