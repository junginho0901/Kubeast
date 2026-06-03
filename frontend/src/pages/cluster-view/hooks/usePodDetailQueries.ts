import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { getAuthHeaders, handleUnauthorized } from '@/services/auth'
import type { PodDetail } from '../types'

// 선택된 Pod 의 manifest (YAML) + describe — 탭이 활성화될 때만 fetch.

interface Params {
  selectedPod: PodDetail | null
  showManifest: boolean
  showDescribe: boolean
}

interface Result {
  manifest: string | undefined
  describeData: any
}

export function usePodDetailQueries({ selectedPod, showManifest, showDescribe }: Params): Result {
  const { data: manifest } = useQuery({
    queryKey: ['pod-yaml', selectedPod?.namespace, selectedPod?.name],
    queryFn: async () => {
      if (!selectedPod) return ''
      const response = await fetch(
        `/api/v1/cluster/namespaces/${selectedPod.namespace}/pods/${selectedPod.name}/yaml`,
        { headers: { ...getAuthHeaders() } },
      )
      if (response.status === 401) {
        handleUnauthorized()
        throw new Error('Unauthorized')
      }
      const data = await response.json()
      return data.yaml as string
    },
    enabled: showManifest && !!selectedPod,
  })

  const { data: describeData } = useQuery({
    queryKey: ['pod-describe', selectedPod?.namespace, selectedPod?.name],
    queryFn: async () => {
      if (!selectedPod) return null
      return await api.describePod(selectedPod.namespace, selectedPod.name)
    },
    enabled: showDescribe && !!selectedPod,
  })

  return { manifest, describeData }
}
