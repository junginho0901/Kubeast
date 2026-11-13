import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import type { ClusterFeatures } from '@/services/api/types'
import { aiEnabled } from '@/utils/features'
import { myRequestsKey, myRequestsQuery } from './myRequestPages'

// The Settings page's Cluster access and API keys sections show only once the server has answered, and what follows
// them moves when they do. The page shows them and what follows together, so nothing moves under the reader.

export type SectionRead = { asked: boolean; fetched: boolean; failures: number }

// Answered, or failed once and being tried again: nothing waits for the second try.
export function sectionsAnswered(reads: SectionRead[]): boolean {
  return reads.every((r) => !r.asked || r.fetched || r.failures > 0)
}

// MCP is asked once the features have come (their placeholder says nothing of AI) and AI is on: off, the gateway takes 3 s to answer 503.
export type MCPRead = 'wait' | 'ask' | 'aiOff'
export function mcpRead(features: ClusterFeatures | undefined, featuresPlaceholder: boolean): MCPRead {
  if (featuresPlaceholder) return 'wait'
  return aiEnabled(features) ? 'ask' : 'aiOff'
}

export function useMCPConfig() {
  const features = useClusterFeatures()
  const state = mcpRead(features.data, features.isPlaceholderData)
  const query = useQuery({ queryKey: ['ai', 'mcp-config'], queryFn: api.getMCPConfig, staleTime: 60_000, enabled: state === 'ask' })
  return { state, query, featuresFailures: features.failureCount }
}

// A read that hangs does not keep the page's settings away for long.
const MOST_WAIT_MS = 1000

// The same reads the two sections make (one request each, whoever asks).
export function useAccountSectionsReady(): boolean {
  const access = useQuery({ queryKey: ['access-requests', 'config'], queryFn: api.getAccessRequestsConfig, staleTime: 60_000 })
  const keys = useQuery({ queryKey: ['api-keys', 'config'], queryFn: api.getAPIKeysConfig, staleTime: 60_000 })
  const mcp = useMCPConfig()
  const accessOn = !!access.data?.enabled
  const keysOn = !!keys.data?.enabled
  const myRequests = useQuery({ queryKey: ['access-requests', 'mine'], queryFn: api.listMyAccessRequests, enabled: accessOn })
  // My requests' first page, the section's own read of it
  const firstRequests = myRequestsQuery(1)
  const myRequestPage = useQuery({ queryKey: myRequestsKey(firstRequests), queryFn: () => api.listMyAccessRequestsPage(firstRequests), enabled: accessOn })
  const myKeys = useQuery({ queryKey: ['api-keys', 'mine'], queryFn: api.listMyAPIKeys, enabled: keysOn })
  const read = (q: { isFetched: boolean; failureCount: number }, asked = true): SectionRead => ({ asked, fetched: q.isFetched, failures: q.failureCount })

  const [waited, setWaited] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), MOST_WAIT_MS)
    return () => clearTimeout(timer)
  }, [])
  return waited || sectionsAnswered([read(access), read(keys), { asked: true, fetched: mcp.state !== 'wait', failures: mcp.featuresFailures }, read(mcp.query, mcp.state === 'ask'), read(myRequests, accessOn), read(myRequestPage, accessOn), read(myKeys, keysOn)])
}
