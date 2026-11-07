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

  // These are the server's words, which multiplexer_watch_test.go holds; one tab cannot free the server's room, nor another tab this tab's.
  it('tells the limit of this tab from the limit of the server', () => {
    recordWatchFrame('a', { type: 'ERROR', error: { message: 'max subscriptions reached for this connection (50), cannot create new watch', reason: 'limit' } })
    expect(getWatchProblem()).toBe('limit')
    resetWatchProblems()
    recordWatchFrame('a', { type: 'ERROR', error: { message: 'max subscriptions reached for the server (2000), cannot create new watch', reason: 'limit' } })
    expect(getWatchProblem()).toBe('server_limit')
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

  it('keeps the limit of a grant apart from a refusal, and below every other problem', () => {
    recordWatchFrame('a', frame('scope'))
    expect(getWatchProblem()).toBe('scope')
    recordWatchFrame('b', frame('unreachable'))
    expect(getWatchProblem()).toBe('unreachable')
    clearWatchProblem('b')
    recordWatchFrame('c', frame('failed'))
    expect(getWatchProblem()).toBe('failed')
  })

  it('forgets a watch the screen closed', () => {
    recordWatchFrame('a', frame('limit'))
    clearWatchProblem('a')
    expect(getWatchProblem()).toBeUndefined()
  })
})
