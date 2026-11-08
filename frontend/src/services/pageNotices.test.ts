import { beforeEach, describe, expect, it } from 'vitest'
import { getWatchProblem, recordWatchFrame, resetWatchProblems } from './watchProblemStore'
import forbiddenBannerSrc from '@/components/ForbiddenBanner.tsx?raw'

const refused = (reason: string) => ({ type: 'ERROR', error: { message: 'x', reason } })

describe('what the page says when the route changes', () => {
  beforeEach(() => resetWatchProblems())

  // A drawer's watch lives across routes and a refusal comes once: cleared on a route change it would never come back,
  // and rows that do not follow would read as if they did. A page's own watch is cleared as it closes
  // (watchMultiplexer.unsubscribe, 'an ERROR frame reaches what the screen says').
  it('leaves the problem of a watch that is still there', () => {
    recordWatchFrame('self\n/api/v1/nodes?watch=1', refused('scope'))
    expect(forbiddenBannerSrc).not.toContain('resetWatchProblems()')
    expect(getWatchProblem()).toBe('scope')
  })
})
