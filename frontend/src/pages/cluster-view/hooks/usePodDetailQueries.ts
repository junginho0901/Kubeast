import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { PodDetail } from '../types'
import { readsPod, type PodRead } from '../podDetailRead'

// 선택된 Pod 의 manifest (YAML) + describe — 탭이 활성화될 때만 fetch.
// The describe is read too while the window was opened from a box's row without containers (podDetailRead): one read
// for both, under the Describe tab's key.

interface Params {
  selectedPod: PodDetail | null
  showManifest: boolean
  showDescribe: boolean
}

interface Result {
  manifest: string | undefined
  describeData: any
  describeError: unknown
  podRead: PodRead
}

export function usePodDetailQueries({ selectedPod, showManifest, showDescribe }: Params): Result {
  const { data: manifest } = useQuery({
    queryKey: ['pod-yaml', selectedPod?.namespace, selectedPod?.name],
    queryFn: async () => {
      if (!selectedPod) return ''
      // through the API client so the selected cluster (?cluster=) and the CSRF
      // header ride along — a bare fetch asked the default cluster and 404ed
      const data = await api.getResourceYaml('pods', selectedPod.name, selectedPod.namespace)
      return data.yaml
    },
    enabled: showManifest && !!selectedPod,
  })

  const describe = useQuery({
    queryKey: ['pod-describe', selectedPod?.namespace, selectedPod?.name],
    queryFn: async () => {
      if (!selectedPod) return null
      return await api.describePod(selectedPod.namespace, selectedPod.name)
    },
    enabled: (showDescribe || readsPod(selectedPod)) && !!selectedPod,
  })

  return {
    manifest,
    describeData: describe.data,
    describeError: describe.error,
    podRead: { data: describe.data, dataAt: describe.dataUpdatedAt, error: describe.error, errorAt: describe.errorUpdatedAt },
  }
}
