// One page of a list the browser holds whole (a search or sort done in the page): the rows of that page, the page
// itself kept within the pages there are, and how many pages there are — at least one, so an empty list keeps its
// footer.

export interface ListPage<T> {
  rows: T[]
  page: number
  pages: number
}

export function pageOf<T>(items: readonly T[], page: number, perPage: number): ListPage<T> {
  const size = Math.max(1, Math.floor(perPage))
  const pages = Math.max(1, Math.ceil(items.length / size))
  const shown = Math.min(Math.max(1, Math.floor(page) || 1), pages)
  return { rows: items.slice((shown - 1) * size, shown * size), page: shown, pages }
}
