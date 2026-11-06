// A conversation opens at its newest page of messages (session-service GET /sessions/{id}); the earlier ones are read
// a page at a time above them, so a list on screen can be longer than any one answer.

type Identified = { id?: number | string }

// The screen's list once a newer answer of the conversation's newest page comes: what the screen holds before that
// page, then the page. Temporary bubbles are not saved messages and give way; a page that no longer meets the screen
// (more than a page was saved elsewhere) replaces it, since keeping the old rows would leave a gap nobody could see.
export function mergeNewestPage<M extends Identified>(shown: M[], newest: M[]): M[] {
  const inPage = new Set(newest.map((m) => m.id))
  const meets = shown.findIndex((m) => inPage.has(m.id))
  return meets > 0 ? [...shown.slice(0, meets), ...newest] : newest
}

// How many of the conversation's messages the screen does not hold: those before the newest page, less the ones the
// screen holds above it.
export function hiddenEarlier(detail: { messages_before?: number; messages?: Identified[] } | null | undefined, shown: Identified[]): number {
  const before = detail?.messages_before ?? 0
  const first = detail?.messages?.[0]?.id
  const above = first === undefined ? -1 : shown.findIndex((m) => m.id === first)
  return Math.max(0, before - Math.max(0, above))
}

// The screen's list with a page of earlier messages above it, each message once.
export function prependEarlier<M extends Identified>(shown: M[], page: M[]): M[] {
  const held = new Set(shown.map((m) => m.id))
  return [...page.filter((m) => !held.has(m.id)), ...shown]
}

// Whether a saved message on screen is older than the conversation's newest page, which is all GET /sessions/{id} holds.
export function olderThanNewestPage(id: number | string | null | undefined, newest: Identified[]): boolean {
  const first = newest[0]?.id
  return typeof id === 'number' && typeof first === 'number' && id < first
}
