import { useQuery } from '@tanstack/react-query'

import { api } from '@/services/api'

// The number of access requests waiting for a decision — the server's count of every pending request, not the
// rows of a page. The sidebar badge and the page's Pending tab read this one query, so they show one number.
export const PENDING_ACCESS_REQUESTS_COUNT_KEY = ['access-requests', 'admin', 'pending-count'] as const

export function usePendingAccessRequestCount({ enabled, refetchInterval }: { enabled: boolean; refetchInterval: number }) {
  return useQuery({
    queryKey: PENDING_ACCESS_REQUESTS_COUNT_KEY,
    queryFn: async () => (await api.adminAccessRequestsPage({ status: 'pending', limit: 0, offset: 0 })).total,
    enabled,
    refetchInterval,
    retry: false,
  })
}
