import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { PodInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'

// namespaces + all-pods + nodes 3개 query 를 묶어 한 hook 으로.
// useKubeWatchList queryKey 는 useQuery 와 정확히 일치 (둘이 drift 하면 watch
// 이벤트가 잘못된 cache 를 update 함).

interface Params {
  selectedNamespace: string
}

interface Result {
  namespaces: { name: string }[] | undefined
  allPods: PodInfo[] | undefined
  nodes: any[] | undefined
  isLoading: boolean
}

export function useClusterPodsQuery({ selectedNamespace }: Params): Result {
  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
  })

  const { data: allPods, isLoading } = useQuery({
    queryKey: ['all-pods', selectedNamespace],
    queryFn: async () => {
      const forceRefresh = true
      if (selectedNamespace === 'all') {
        const pods = await Promise.all(
          (namespaces || []).map((ns) => api.getPods(ns.name, undefined, forceRefresh)),
        )
        return pods.flat()
      } else {
        return await api.getPods(selectedNamespace, undefined, forceRefresh)
      }
    },
    enabled: !!namespaces,
  })

  useKubeWatchList({
    enabled: !!namespaces,
    queryKey: ['all-pods', selectedNamespace],
    path:
      selectedNamespace === 'all'
        ? '/api/v1/pods'
        : `/api/v1/namespaces/${selectedNamespace}/pods`,
    query: 'watch=1',
  })

  const { data: nodes } = useQuery({
    queryKey: ['nodes'],
    queryFn: () => api.getNodes(false),
  })

  return { namespaces, allPods, nodes, isLoading }
}
