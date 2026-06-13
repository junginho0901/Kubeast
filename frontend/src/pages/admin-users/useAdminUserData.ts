// AdminUsers 의 4 useQuery (team / roles / me / users) 묶음. AdminUsers.tsx
// 에서 추출 (Phase 3.4.a). 외부 reauthModalOpen 만 prop 으로 받음.

import { useQuery } from '@tanstack/react-query'

import { api, RoleWithDetails } from '@/services/api'

interface Args {
  reauthModalOpen: boolean
  limit: number
  offset: number
}

export function useAdminUserData({ reauthModalOpen, limit, offset }: Args) {
  const { data: teamOptions = [] } = useQuery({
    queryKey: ['organizations', 'team'],
    queryFn: () => api.listOrganizations('team'),
    staleTime: 60000,
  })

  const { data: roles = [] } = useQuery<RoleWithDetails[]>({
    queryKey: ['roles'],
    queryFn: api.listRoles,
    staleTime: 60000,
  })

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
    retry: false,
    enabled: !reauthModalOpen,
  })

  const { data: users, isLoading, isError } = useQuery({
    queryKey: ['admin-users', limit, offset],
    queryFn: () => api.adminListUsers({ limit, offset }),
    staleTime: 5000,
    retry: false,
    enabled: !reauthModalOpen,
  })

  return { teamOptions, roles, me, users, isLoading, isError }
}
