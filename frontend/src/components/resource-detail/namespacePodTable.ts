import type { PodPage } from '@/services/api'
import { podPagePollEvery } from '@/services/podPageRead'

// Up to this many pods a drawer's table reads them whole and follows them by a watch: five accounts reading 2 000 at once hold some 34 MiB (TestWholeNamespacePodReadCost), what 500 people left of the GC's 461 (docs/architecture.md "Many users").
export const POD_TABLE_WATCH_MAX = 2000

// The same line for the tables of a selector's or a workload's pods (Service, PodDisruptionBudget, workloads), each open drawer following them by a watch of its own (TestStalledWatchSubscriberHeldCost).
export const SET_POD_TABLE_WATCH_MAX = 2000

// The note over a table read a page at a time, naming what passed the line: the namespace's pods, a selector's matches or a workload's pods.
export function podTableNote(owner: string | undefined, bySelector: boolean): { text: string; values: Record<string, string> } {
  if (owner) {
    return { text: 'This {{kind}} has too many pods to follow live, so this table is read again every {{seconds}} seconds.', values: { kind: owner.split('/')[0] } }
  }
  if (bySelector) return { text: 'Too many pods match this selector to follow live, so this table is read again every {{seconds}} seconds.', values: {} }
  return { text: 'This namespace has too many pods to follow live, so this table is read again every {{seconds}} seconds.', values: {} }
}

// A first page the server failed to answer is asked again this often.
const FIRST_READ_RETRY_MS = 10_000

// The pods a table's whole read would hold: the namespace's, or the matches of a label selector, which the API server applies.
export function podTableSize(page: PodPage, bySelector: boolean): number {
  return bySelector ? page.total : (page.stats?.total ?? 0)
}

// Whether the table reads the server's pages, with no whole read and no watch: the page or the rows held pass the line.
export function podTableReadsPages({ answered, held }: { answered?: PodPage; held?: number }, bySelector: boolean, line = POD_TABLE_WATCH_MAX): boolean {
  return (held !== undefined && held > line) || (answered !== undefined && podTableSize(answered, bySelector) > line)
}

// Whether it reads the pods whole: once a page said they are few, or on a 4xx, which refuses the whole read as well.
export function podTableReadsWhole(pages: boolean, answered: boolean, refused: boolean): boolean {
  return !pages && (answered || refused)
}

// The rows shown: the whole read's while it follows them, and after it stops until a newer page came, so nothing blinks.
export function podTableShows(options: { pages: boolean; held: boolean; answered: boolean; pageAt: number; heldAt: number }): 'whole' | 'page' {
  const { pages, held, answered, pageAt, heldAt } = options
  if (!held) return 'page'
  if (!pages) return 'whole'
  return answered && pageAt >= heldAt ? 'page' : 'whole'
}

// A page from a server that did not apply every condition asked (one from before them names none): its rows are not the table's.
export class PodPageNotFiltered extends Error {}

const ECHOED = ['namespace', 'config_map', 'secret', 'service_account', 'label_selector', 'owner'] as const

export function podPageApplied(asked: Partial<Record<(typeof ECHOED)[number], unknown>>, page: PodPage): boolean {
  const filters = page.filters
  return filters !== undefined && ECHOED.every((key) => !asked[key] || filters[key] === asked[key])
}

// How a picker offers a namespace's pods: the whole list up to the line or on a 4xx, else the server's matches of what is typed.
export function podPickerWay(count: PodPage | undefined, error: unknown): 'list' | 'search' | 'wait' {
  if (count) return podTableSize(count, false) > POD_TABLE_WATCH_MAX ? 'search' : 'list'
  if (error) return isClientError(error) ? 'list' : 'search'
  return 'wait'
}

export function isClientError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null)?.response?.status
  return status !== undefined && status >= 400 && status < 500
}

// How often the page is read again: as the Pods page while reading pages, a first page that failed unless refused.
export function podTableReadEvery(pages: boolean, data: PodPage | undefined, error: unknown): number | false {
  if (error instanceof PodPageNotFiltered) return false
  if (data) return pages ? podPagePollEvery(data) : false
  return error && !isClientError(error) ? FIRST_READ_RETRY_MS : false
}
