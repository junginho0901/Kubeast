import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { PodNodeSummary } from '@/services/api'

// The namespaces, the nodes and the node map: how many pods each node has and their colours, counted by k8s-service
// (pods_nodes.go) so the page never holds every pod of a large cluster. Each node box fetches and watches its own
// pods when it comes on screen (PodNodeGrid). The map asks again every 2 s with the revision it has; while nothing a
// row shows changed the server answers "unchanged".

interface Params {
  selectedNamespace: string
  search: string
}

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
    placeholderData: keepPreviousData,
    // listed counts (no revision) cost the cluster a list: ask less often
    refetchInterval: (query) => {
      const d = query.state.data
      if (!d) return false
      return d.revision ? 2000 : 30000
    },
  })

  const { data: nodes } = useQuery({
    queryKey: ['nodes'],
    queryFn: () => api.getNodes(false),
  })

  return { namespaces, summary, nodes, isLoading }
}
