import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { api, type PodListRow, type PodPage, type PodPageParams } from './api'

// A poll sends the revision it holds: while no row it may see changed the server answers "unchanged" before it sorts anything, and the rows on hand stay.
export async function readPodPageSince(client: QueryClient, key: QueryKey, params: PodPageParams): Promise<PodPage> {
  const held = client.getQueryData<PodPage>(key)
  const next = await api.getPodPage({ ...params, revision: held?.revision || undefined })
  return next.unchanged && held ? held : next
}

// How often a screen that follows a page of pods reads it again: less often past ten thousand pods, and listed rows (no revision) cost the cluster a list.
export function podPagePollEvery(page: PodPage | undefined): number | false {
  if (!page) return false
  if (!page.revision) return 30_000
  return page.stats.total > 10_000 ? 10_000 : 3_000
}

// Whether a pod's row differs between two pages. A pod in neither is one the rows cannot speak for, which reads as changed.
export function podRowChanged(before: PodListRow[] | undefined, after: PodListRow[] | undefined, pod: { namespace?: string; name: string }): boolean {
  const rowOf = (rows: PodListRow[] | undefined) => rows?.find((row) => row.name === pod.name && row.namespace === pod.namespace)
  const was = rowOf(before)
  const is = rowOf(after)
  return !was || !is || JSON.stringify(was) !== JSON.stringify(is)
}
