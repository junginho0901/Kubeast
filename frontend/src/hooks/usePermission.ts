import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { isLoggedIn } from '@/services/auth'

export function usePermission() {
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    enabled: isLoggedIn(),
    retry: false,
    staleTime: 30000,
  })

  const perms: string[] = me?.role?.permissions ?? []

  const has = (perm: string): boolean =>
    perms.some(
      (p) =>
        p === '*' ||
        p === perm ||
        (p.endsWith('.*') && perm.startsWith(p.slice(0, -1)))
    )

  return { has, permissions: perms, role: me?.role ?? null }
}
