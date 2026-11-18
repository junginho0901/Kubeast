import { beforeEach, describe, expect, it } from 'vitest'
import { clearWatchProblem, getWatchProblem, recordWatchFrame, resetWatchProblems } from './watchProblemStore'

const frame = (reason?: string) => ({ type: 'ERROR', error: { message: 'm', reason } })

describe('what the screen says about its live updates', () => {
  beforeEach(() => resetWatchProblems())

  it('says nothing while every watch answers', () => {
    recordWatchFrame('a', { type: 'DATA' })
    expect(getWatchProblem()).toBeUndefined()
  })

  it('keeps a refusal, a limit and an unreachable cluster', () => {
    recordWatchFrame('a', frame('forbidden'))
    expect(getWatchProblem()).toBe('forbidden')
    resetWatchProblems()
    recordWatchFrame('a', frame('limit'))
    expect(getWatchProblem()).toBe('limit')
    resetWatchProblems()
    recordWatchFrame('a', frame('unreachable'))
    expect(getWatchProblem()).toBe('unreachable')
    resetWatchProblems()
    recordWatchFrame('a', frame('failed'))
    expect(getWatchProblem()).toBe('failed')
  })

  // `limit_scope` is the server's, held by TestALimitFrameSaysWhichLimit; one tab cannot free the server's room, nor another tab this tab's.
  it('tells the limit of this tab from the limit of the server by the field the server sends, whatever its message says', () => {
    recordWatchFrame('a', { type: 'ERROR', error: { message: 'for the server', reason: 'limit', limit_scope: 'tab' } })
    expect(getWatchProblem()).toBe('limit')
    resetWatchProblems()
    recordWatchFrame('a', { type: 'ERROR', error: { message: 'max subscriptions', reason: 'limit', limit_scope: 'server' } })
    expect(getWatchProblem()).toBe('server_limit')
    resetWatchProblems()
    // the server's memory, held by TestANewWatchWaitsWhileTheMemoryHeldIsPastItsShare
    recordWatchFrame('a', { type: 'ERROR', error: { message: 'short of memory', reason: 'limit', limit_scope: 'memory' } })
    expect(getWatchProblem()).toBe('server_memory')
    resetWatchProblems()
    // a list waiting for its turn to open, held by TestALongWaitForAnOpeningIsToldAsAWaitForItsTurn: not the memory
    recordWatchFrame('a', { type: 'ERROR', error: { message: 'k8s-service opens a few lists at a time to keep its memory in bounds; this one waits for its turn', reason: 'limit', limit_scope: 'opening' } })
    expect(getWatchProblem()).toBe('server_opening')
    resetWatchProblems()
    // a scope from a server newer than this screen, as a screen before `opening` read that one
    recordWatchFrame('a', { type: 'ERROR', error: { message: 'm', reason: 'limit', limit_scope: 'not-yet-known' } })
    expect(getWatchProblem()).toBe('limit')
    resetWatchProblems()
    // a server older than the field, while an upgrade is under way
    recordWatchFrame('a', { type: 'ERROR', error: { message: 'max subscriptions reached for the server (2000), cannot create new watch', reason: 'limit' } })
    expect(getWatchProblem()).toBe('limit')
    resetWatchProblems()
    recordWatchFrame('a', frame('limit'))
    expect(getWatchProblem()).toBe('limit')
  })

  it('ignores what the page already says or has no watch to lose', () => {
    recordWatchFrame('a', frame('not_served'))
    recordWatchFrame('b', frame('unsupported'))
    expect(getWatchProblem()).toBeUndefined()
  })

  it('reads a frame from a server older than the reason as a failure', () => {
    recordWatchFrame('a', { type: 'ERROR', error: { message: 'something' } })
    expect(getWatchProblem()).toBe('failed')
  })

  it('clears when the same watch answers again', () => {
    recordWatchFrame('a', frame('unreachable'))
    recordWatchFrame('a', { type: 'RESYNC' })
    expect(getWatchProblem()).toBeUndefined()
    recordWatchFrame('a', frame('unreachable'))
    recordWatchFrame('a', { type: 'DATA' })
    expect(getWatchProblem()).toBeUndefined()
  })

  it('another watch answering clears nothing', () => {
    recordWatchFrame('a', frame('unreachable'))
    recordWatchFrame('b', { type: 'DATA' })
    expect(getWatchProblem()).toBe('unreachable')
  })

  it('names the most serious of several', () => {
    recordWatchFrame('a', frame('unreachable'))
    recordWatchFrame('b', frame('limit'))
    expect(getWatchProblem()).toBe('limit')
    recordWatchFrame('c', frame('forbidden'))
    expect(getWatchProblem()).toBe('forbidden')
  })

  it('keeps the limit of a grant apart from a refusal, and below every other problem but a list waiting for its turn', () => {
    recordWatchFrame('a', frame('scope'))
    expect(getWatchProblem()).toBe('scope')
    recordWatchFrame('b', frame('unreachable'))
    expect(getWatchProblem()).toBe('unreachable')
    clearWatchProblem('b')
    recordWatchFrame('c', frame('failed'))
    expect(getWatchProblem()).toBe('failed')
  })

  // It starts by itself within seconds, so whatever else stopped a list on the page is what the page says.
  it('names a list waiting for its turn to open last, and drops it when its watch is on', () => {
    const opening = { type: 'ERROR', error: { message: 'm', reason: 'limit', limit_scope: 'opening' } }
    recordWatchFrame('a', opening)
    expect(getWatchProblem()).toBe('server_opening')
    recordWatchFrame('b', frame('scope'))
    expect(getWatchProblem()).toBe('scope')
    clearWatchProblem('b')
    recordWatchFrame('c', { type: 'ERROR', error: { message: 'm', reason: 'limit', limit_scope: 'memory' } })
    expect(getWatchProblem()).toBe('server_memory')
    clearWatchProblem('c')
    expect(getWatchProblem()).toBe('server_opening')
    recordWatchFrame('a', { type: 'RESYNC' })
    expect(getWatchProblem()).toBeUndefined()
  })

  it('forgets a watch the screen closed', () => {
    recordWatchFrame('a', frame('limit'))
    clearWatchProblem('a')
    expect(getWatchProblem()).toBeUndefined()
  })
})
