import { describe, expect, it } from 'vitest'
import { failureFields, readFailure } from './readFailure'

// A read that did not answer, as a layer tells it: a refusal with the server's reason, else the status and the reason
// the screen shows (failureText), and no status when no answer came.

describe('readFailure', () => {
  it('a 403 is a refusal with the server\'s reason', () => {
    expect(readFailure({ response: { status: 403, data: { detail: 'pods is forbidden' } }, message: 'Request failed with status code 403' }))
      .toEqual({ refused: true, reason: 'pods is forbidden' })
  })

  it('a server error keeps its status and reason; one without a reason says the request\'s words', () => {
    expect(readFailure({ response: { status: 500, data: { detail: 'etcdserver: request timed out' } }, message: 'x' })).toEqual({ status: 500, reason: 'etcdserver: request timed out' })
    expect(readFailure({ response: { status: 502, data: '<html>' }, message: 'Request failed with status code 502' })).toEqual({ status: 502, reason: 'Request failed with status code 502' })
  })

  it('no answer has no status', () => {
    expect(readFailure({ message: 'Network Error' })).toEqual({ reason: 'Network Error' })
  })
})

describe('failureFields', () => {
  it('names the fields after the read', () => {
    expect(failureFields('history', { response: { status: 403, data: { detail: 'no' } } })).toEqual({ history_refused: 'no' })
    expect(failureFields('history', { response: { status: 500, data: { detail: 'down' } } })).toEqual({ history_failed: { status: 500, reason: 'down' } })
  })

  it('takes the plain names without one', () => {
    expect(failureFields('', { response: { status: 403, data: { detail: 'no' } } })).toEqual({ refused: 'no' })
    expect(failureFields('', { message: 'Network Error' })).toEqual({ failed: { status: undefined, reason: 'Network Error' } })
  })
})
