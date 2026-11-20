/**
 * What a sortable column header's cell spreads on itself: its click sorts by the column (the SortButton in it gives the
 * keyboard that click), and `aria-sort` tells a screen reader the order the table is in. Only the header the table is
 * sorted by carries it, ascending or descending; the other sortable headers carry none, as WAI-ARIA 1.2 asks for one
 * header at a time and the APG Sortable Table example does. The click and the order come from one key, so a header
 * cannot sort by one column and say another's order.
 */
export function sortHeaderProps<K>(sortKey: K | null, sortDir: 'asc' | 'desc', sort: (key: K) => void) {
  return (key: K): { onClick: () => void; 'aria-sort': 'ascending' | 'descending' | undefined } => ({
    onClick: () => sort(key),
    'aria-sort': sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined,
  })
}
