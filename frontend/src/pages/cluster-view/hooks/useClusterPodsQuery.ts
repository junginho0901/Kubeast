import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { PodNodeSummary } from '@/services/api'
import { keepSameRead } from '@/utils/keepSameRead'
import { LIST_GATHER_MS, useKubeWatchList } from '@/services/useKubeWatchList'

// The namespaces, the nodes and the node map: how many pods each node has and their colours, counted by k8s-service
// (pods_nodes.go) so the page never holds every pod of a large cluster. Each node box fetches and watches its own
// pods when it comes on screen (PodNodeGrid). The map asks again every 2 s with the revision it has; while nothing a
// row shows changed the server answers "unchanged". The node list (control planes first, the NotReady and cordoned
// marks, the floating chat's node counts) follows the cluster through the Nodes page's own watch of /api/v1/nodes,
// shared on the tab with that page and a Node drawer: no poll, one watch per tab, its frames the node list's rows.

interface Params {
  selectedNamespace: string
  search: string
}

// the Nodes page's key, so both read and follow one list
export const NODE_LIST_KEY = ['cluster', 'nodes']

export function useClusterPodsQuery({ selectedNamespace, search }: Params) {
  const queryClient = useQueryClient()
  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
  })

  const params = { namespace: selectedNamespace === 'all' ? undefined : selectedNamespace, q: search || undefined }
  const key = ['cluster-view', 'nodes', params]
  const { data: summary, isLoading } = useQuery({
    queryKey: key,
    queryFn: async () => {
      const prev = queryClient.getQueryData<PodNodeSummary>(key)
      const next = await api.getPodNodeSummary({ ...params, revision: prev?.revision || undefined })
      return next.unchanged && prev ? prev : next
    },
    // another namespace's map waits for its own answer; a search keeps the boxes (and their watches) while it is counted
    placeholderData: keepSameRead(key, ['q']),
    // listed counts (no revision) cost the cluster a list: ask less often
    refetchInterval: (query) => {
      const d = query.state.data
      if (!d) return false
      return d.revision ? 2000 : 30000
    },
  })

  const { data: nodes } = useQuery({
    queryKey: NODE_LIST_KEY,
    queryFn: () => api.getNodes(false),
  })
  // only once the list was read: a grant the cluster refuses nodes is not asked again by a watch
  useKubeWatchList({
    enabled: Array.isArray(nodes),
    queryKey: NODE_LIST_KEY,
    path: '/api/v1/nodes',
    query: 'watch=1',
    gatherEveryMs: LIST_GATHER_MS,
  })

  return { namespaces, summary, nodes, isLoading }
}
