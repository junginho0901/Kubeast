import { describe, expect, it } from 'vitest'

import { failureText } from './failureText'

describe('what a failed request says', () => {
  it('is the reason the server wrote', () => {
    expect(failureText({ response: { status: 403, data: { detail: 'forbidden: no access to cluster default' } }, message: 'Request failed with status code 403' }))
      .toBe('forbidden: no access to cluster default')
  })

  it("is each of FastAPI's field errors", () => {
    const err = { response: { status: 422, data: { detail: [{ loc: ['body', 'name'], msg: 'Field required' }, { loc: ['body', 'url'], msg: 'Invalid URL' }] } }, message: 'x' }
    expect(failureText(err)).toBe('Field required; Invalid URL')
  })

  it("is the request's own error when the answer gives no reason", () => {
    expect(failureText({ response: { status: 502, data: '<html>Bad Gateway</html>' }, message: 'Request failed with status code 502' })).toBe('Request failed with status code 502')
    expect(failureText({ response: { status: 500, data: { detail: '  ' } }, message: 'Request failed with status code 500' })).toBe('Request failed with status code 500')
    expect(failureText({ response: { status: 503, data: { detail: { code: 'METRICS_UNAVAILABLE' } } }, message: 'Request failed with status code 503' })).toBe('Request failed with status code 503')
    expect(failureText(new Error('Network Error'))).toBe('Network Error')
  })

  it('is never empty', () => {
    expect(failureText('timeout')).toBe('timeout')
    expect(failureText(undefined)).toBe('undefined')
  })
})
