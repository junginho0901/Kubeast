import { CheckCircle, ChevronDown } from 'lucide-react'
import { useClusterView } from './ClusterViewContext'

interface Props {
  namespaces: { name: string }[] | undefined
}

// 네임스페이스 커스텀 드롭다운. 외부 클릭 close 는 useClusterEffects 가 처리.

export function NamespaceDropdown({ namespaces }: Props) {
  const {
    tr,
    selectedNamespace, setSelectedNamespace,
    isNamespaceDropdownOpen, setIsNamespaceDropdownOpen,
    namespaceDropdownRef,
  } = useClusterView()

  return (
    <div className="relative" ref={namespaceDropdownRef}>
      <button
        onClick={() => setIsNamespaceDropdownOpen(!isNamespaceDropdownOpen)}
        className="h-10 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors flex items-center gap-2 min-w-[200px] justify-between"
      >
        <span className="text-sm font-medium">
          {selectedNamespace === 'all'
            ? tr('clusterView.allNamespaces', 'All namespaces')
            : selectedNamespace}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-slate-400 transition-transform ${
            isNamespaceDropdownOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      {isNamespaceDropdownOpen && (
        <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-50 max-h-[400px] overflow-y-auto">
          <button
            onClick={() => {
              setSelectedNamespace('all')
              setIsNamespaceDropdownOpen(false)
            }}
            className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg"
          >
            {selectedNamespace === 'all' && (
              <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
            )}
            <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>
              {tr('clusterView.allNamespaces', 'All namespaces')}
            </span>
          </button>
          {Array.isArray(namespaces) && namespaces.map((ns) => (
            <button
              key={ns.name}
              onClick={() => {
                setSelectedNamespace(ns.name)
                setIsNamespaceDropdownOpen(false)
              }}
              className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 last:rounded-b-lg"
            >
              {selectedNamespace === ns.name && (
                <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
              )}
              <span className={selectedNamespace === ns.name ? 'font-medium' : ''}>
                {ns.name}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
