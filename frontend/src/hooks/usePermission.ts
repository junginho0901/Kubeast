import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useCluster } from '@/contexts/ClusterContext'
import { hasPermission, parsePermissions, type PermissionMatrix } from '@/utils/permissions'

export function usePermission() {
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: false,
    staleTime: 30000,
  })
  const { currentCluster } = useCluster()

  // Effective permissions are the per-cluster matrix GET /auth/me returns — the
  // same matrix the backend puts in the token and enforces — not the global
  // role's flat list. Using the role list would show actions the backend then
  // 403s for a non-admin without a per-cluster grant.
  const matrix = useMemo<PermissionMatrix>(() => parsePermissions(me?.permissions_matrix), [me])

  // has(perm, clusterID?) — clusterID defaults to the selected cluster, so the
  // existing has(perm) call sites become cluster-aware automatically. A global
  // admin (matrix["*"] = ["*"]) still passes everything.
  const has = (perm: string, clusterID?: string): boolean =>
    hasPermission(matrix, perm, clusterID ?? currentCluster)

  return { has, permissions: matrix, role: me?.role ?? null }
}
