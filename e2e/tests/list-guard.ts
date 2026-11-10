// The list rule of every screen (decided 2026-11-09): a table whose rows grow with the data has the list footer
// (ListPager), and a page with a list footer fits the screen. screen-consistency.spec.ts runs listsOnScreen on each
// sidebar screen and holds what it finds with listProblems; list-guard-exempt.json names what the DOM cannot mark.

export type ListsOnScreen = {
  // tables with rows of data and no list footer in their card, each as "<where> (<first header cells>)"
  unpaged: string[]
  // the list footers shown (data-testid ending in "pager") and whether each offers the rows-per-page choice
  pagers: { id: string; chooser: boolean }[]
}

// What listsOnScreen reads of an element; a browser Element has all of it.
export type GuardNode = {
  tagName: string
  children: ArrayLike<GuardNode>
  parentElement: GuardNode | null
  textContent: string | null
  getAttribute(name: string): string | null
  closest?(selector: string): unknown
  getClientRects?(): { length: number }
}

// Runs in the page (page.evaluate sends its text, so it uses nothing from outside itself) or on any GuardNode tree.
// A row of data is a tbody row that is neither a filler row (aria-hidden) nor a notice row (one cell over several
// columns: empty, loading, error); a table's card is the largest box around it that holds no other table.
export function listsOnScreen(arg: { root?: GuardNode; skip?: string[] }): ListsOnScreen {
  const root = arg.root ?? (document.querySelector('main') as unknown as GuardNode | null)
  if (!root) return { unpaged: [], pagers: [] }
  const skip = arg.skip ?? []
  const kids = (el: GuardNode) => Array.from(el.children)
  const below = (el: GuardNode): GuardNode[] => kids(el).flatMap((c) => [c, ...below(c)])
  const tag = (el: GuardNode) => el.tagName.toLowerCase()
  const shown = (el: GuardNode) => typeof el.getClientRects !== 'function' || el.getClientRects().length > 0
  const testId = (el: GuardNode) => el.getAttribute('data-testid') ?? ''
  const isPager = (el: GuardNode) => /pager$/.test(testId(el)) && shown(el)
  const inside = (el: GuardNode, box: GuardNode) => {
    for (let e: GuardNode | null = el; e; e = e.parentElement) if (e === box) return true
    return false
  }
  const upToRoot = (el: GuardNode) => {
    const out: GuardNode[] = []
    for (let e: GuardNode | null = el; e; e = e === root ? null : e.parentElement) out.push(e)
    return out
  }
  const all = below(root)
  const tables = all.filter((e) => tag(e) === 'table' && shown(e))
  const unpaged: string[] = []
  for (const table of tables) {
    if (upToRoot(table).some((e) => (e.getAttribute('data-list-bounded') ?? '').trim() !== '')) continue
    if (typeof table.closest === 'function' && skip.some((s) => table.closest!(s))) continue
    const rows = kids(table)
      .filter((b) => tag(b) === 'tbody' && b.getAttribute('aria-hidden') !== 'true')
      .flatMap(kids)
      .filter((tr) => tag(tr) === 'tr' && !(kids(tr).length === 1 && Number(kids(tr)[0].getAttribute('colspan') ?? '1') > 1))
    if (rows.length === 0) continue
    const others = tables.filter((t) => t !== table && !inside(t, table) && !inside(table, t))
    let card = table
    while (card.parentElement && card.parentElement !== root && !others.some((t) => inside(t, card.parentElement!))) card = card.parentElement
    if ([card, ...below(card)].some(isPager)) continue
    const where = upToRoot(table).map(testId).find((id) => id !== '') || 'a table'
    const heads = below(table).filter((e) => tag(e) === 'th').slice(0, 4).map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())
    unpaged.push(`${where} (${heads.join(' | ')})`)
  }
  const pagers = all.filter(isPager).map((p) => ({ id: testId(p), chooser: below(p).some((e) => testId(e) === 'page-size') }))
  return { unpaged, pagers }
}

// A list the rule leaves out that the screen cannot mark itself: a table by selector, or a footer of a fixed page size
// in a page that scrolls by design.
export type ListExemption = { screen: RegExp; selector?: string; pager?: RegExp; why: string; pr: string }

export function readExemptions(raw: { rules: { screen: string; selector?: string; pager?: string; why: string; pr: string }[] }): ListExemption[] {
  return raw.rules.map((r) => {
    if (!r.screen || !r.why?.trim() || !r.pr?.trim() || Number(!!r.selector) + Number(!!r.pager) !== 1) {
      throw new Error(`a list exemption names a screen, a selector or a pager, a reason and a PR: ${JSON.stringify(r)}`)
    }
    return { screen: new RegExp(r.screen), selector: r.selector, pager: r.pager ? new RegExp(r.pager) : undefined, why: r.why, pr: r.pr }
  })
}

// The selectors of the tables the exemptions leave out on the screen at `path`, for listsOnScreen.
export const skippedTables = (path: string, rules: ListExemption[]) => rules.filter((r) => r.screen.test(path) && r.selector).map((r) => r.selector!)

// The footers that hold the page to the screen: every one but a fixed page size the exemptions name.
export const footersThatFit = (path: string, lists: ListsOnScreen, rules: ListExemption[]) =>
  lists.pagers.filter((p) => p.chooser || !rules.some((r) => r.screen.test(path) && r.pager?.test(p.id))).map((p) => p.id)

// What the screen at `path` does against the rule; `overflow` is how far the page scrolls at 1440×900 (null: not read).
export function listProblems(path: string, lists: ListsOnScreen, rules: ListExemption[], overflow: number | null): string[] {
  const out = lists.unpaged.map((t) => `${path}: ${t} lists rows with no list footer (ListPager) in its card; page it, or mark it data-list-bounded="<why it stays small>"`)
  const footers = footersThatFit(path, lists, rules)
  if (footers.length > 0 && overflow !== null && overflow > 1) {
    out.push(`${path}: the page scrolls ${overflow}px at 1440×900 with the list footer ${footers.join(', ')}; the list and its footer fit the screen (Fit)`)
  }
  return out
}
