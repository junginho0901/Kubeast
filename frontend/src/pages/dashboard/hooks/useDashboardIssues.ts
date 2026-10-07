import { useMemo } from 'react'

import type { ClusterIssuesResponse } from '@/services/api/types'

import { deriveIssues, type DerivedIssues } from '../issues'

interface Params {
  issues: ClusterIssuesResponse | undefined
  issuesSearchQuery: string
  isIssuesModalOpen: boolean
  isLoadingIssues: boolean
}

interface Result extends DerivedIssues {
  isIssuesLoading: boolean
  generatedAt?: string
  windowMinutes?: number
}

// The issues come aggregated from /api/v1/cluster/issues; this only
// searches, orders and groups them for the modal.
export function useDashboardIssues({ issues, issuesSearchQuery, isIssuesModalOpen, isLoadingIssues }: Params): Result {
  return useMemo(() => ({
    ...deriveIssues(issues?.issues, issuesSearchQuery),
    isIssuesLoading: isIssuesModalOpen && isLoadingIssues && !issues,
    generatedAt: issues?.generated_at,
    windowMinutes: issues?.window_minutes,
  }), [issues, issuesSearchQuery, isIssuesModalOpen, isLoadingIssues])
}
