import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'

// Why this install cannot run a provider (the Claude subscription without its image or chart switch), by provider
// id; a provider missing from the map can run. The model forms grey it out and say why before Test or Save.
export function useProviderAvailability(): Record<string, string> {
  const { data } = useQuery({
    queryKey: ['ai-provider-availability'],
    queryFn: api.providerAvailability,
    staleTime: 60_000,
    retry: false,
  })
  const out: Record<string, string> = {}
  for (const [id, entry] of Object.entries(data?.providers ?? {})) {
    if (!entry.available) out[id] = entry.reason || 'not available'
  }
  return out
}
