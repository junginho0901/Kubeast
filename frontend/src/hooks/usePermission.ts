import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { isLoggedIn, getAccessToken } from '@/services/auth'
import { useCluster } from '@/contexts/ClusterContext'
import { getTokenMatrix, hasPermission, type PermissionMatrix } from '@/utils/permissions'

export function usePermission() {
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    enabled: isLoggedIn(),
    retry: false,
    staleTime: 30000,
  })
  const { currentCluster } = useCluster()

  // Effective permissions are the per-cluster matrix carried in the JWT — the
  // same thing the backend enforces — not the global role's flat list. Using
  // the role list would show actions the backend then 403s for a non-admin
  // without a per-cluster grant. Recompute when the token / identity changes.
  const token = getAccessToken()
  const matrix = useMemo<PermissionMatrix>(() => getTokenMatrix(), [token, me])

  // has(perm, clusterID?) — clusterID defaults to the selected cluster, so the
  // existing has(perm) call sites become cluster-aware automatically. A global
  // admin (matrix["*"] = ["*"]) still passes everything.
  const has = (perm: string, clusterID?: string): boolean =>
    hasPermission(matrix, perm, clusterID ?? currentCluster)

  return { has, permissions: matrix, role: me?.role ?? null }
}
