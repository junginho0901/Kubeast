import type { JSX } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useCluster } from '@/contexts/ClusterContext'
import { usePermission } from '@/hooks/usePermission'
import { waitsForCluster } from '@/utils/permissions'

interface Props {
  // one permission, or several of which any opens the page
  permission: string | string[]
  children: JSX.Element
}

export default function RequirePermission({ permission, children }: Props) {
  const location = useLocation()
  const { has, permissions } = usePermission()
  const { currentCluster } = useCluster()
  const keys = Array.isArray(permission) ? permission : [permission]

  const { isLoading, isError } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: false,
    staleTime: 30000,
  })

  if (isError) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (isLoading || waitsForCluster(keys, currentCluster, permissions)) {
    return <div className="min-h-screen bg-slate-900" />
  }

  if (!keys.some((p) => has(p))) {
    return <Navigate to="/" replace />
  }

  return children
}
