import { hashKey, type QueryKey } from '@tanstack/react-query'

// placeholderData for a list whose key holds its page. keepPreviousData gives the last answer of any key while a new
// key loads, as a success with isPlaceholderData, so a screen that reads isLoading draws another filter's, search's or
// cluster's rows as the new one's answer. This gives it only when the previous key differs in `page` alone; for another
// read the query stays pending and isLoading, as on first open, until its own answer comes.
// `page` names the parts that only turn the page or reorder the same rows: a number is a place in the key, a text a
// field of an object in the key.
export function keepSameRead(key: QueryKey, page: ReadonlyArray<number | string>) {
  const want = readOf(key, page)
  return <T>(previous: T | undefined, previousQuery?: { queryKey: QueryKey }): T | undefined =>
    previousQuery !== undefined && readOf(previousQuery.queryKey, page) === want ? previous : undefined
}

function readOf(key: QueryKey, page: ReadonlyArray<number | string>): string {
  const left = Object.fromEntries(page.filter((p) => typeof p === 'string').map((field) => [field, undefined]))
  return hashKey(key.filter((_, at) => !page.includes(at)).map((part) =>
    part !== null && typeof part === 'object' && !Array.isArray(part) ? { ...part, ...left } : part))
}
