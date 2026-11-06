import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, describe, expect, it } from 'vitest'
import { client, isMetricsUnavailableError } from './client'
import { metricsApi } from './metrics'

// "This cluster has no metrics-server" stops the polling and puts up its own notice, for the rest of the tab's life.
// Only an answer that says so may do that: any other failure is an error, retried, and goes away when the server does.

const originalAdapter = client.defaults.adapter
afterEach(() => {
  client.defaults.adapter = originalAdapter
})

const answering = (status: number, data: unknown) => {
  client.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    throw new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, { status, statusText: '', data, headers: {}, config })
  }
}
const failureOf = async (call: () => Promise<unknown>) => {
  try {
    await call()
  } catch (err) {
    return err
  }
  throw new Error('the call did not fail')
}

const calls: [string, () => Promise<unknown>][] = [
  ['node metrics', () => metricsApi.getNodeMetrics()],
  ['pod metrics', () => metricsApi.getPodMetrics('demo')],
  ['top resources', () => metricsApi.getTopResources()],
]

describe('the answer that says metrics-server is missing', () => {
  it.each(calls)('%s: what the API call throws is recognised as missing', async (_name, call) => {
    answering(503, { detail: 'metrics_unavailable' })
    expect(isMetricsUnavailableError(await failureOf(call))).toBe(true)
  })

  it('the dashboard\'s own error for an empty top-resources answer is recognised as missing', () => {
    expect(isMetricsUnavailableError({ response: { status: 503, data: { code: 'metrics_unavailable' } } })).toBe(true)
  })
})

describe('any other failure of a metrics read', () => {
  it.each<[string, number, unknown]>([
    ['a gateway\'s plain 503', 503, 'gateway temporarily unavailable'],
    ['a 503 without a body', 503, undefined],
    ['the cluster being unreachable', 503, { detail: 'cluster demo is currently unreachable' }],
    ['metrics-server not answering', 502, { detail: 'get node metrics (status 503): the server is currently unable to handle the request (get nodes.metrics.k8s.io)' }],
    ['a server error', 500, { detail: 'boom' }],
    ['the missing code on a status other than 503', 500, { code: 'metrics_unavailable' }],
  ])('%s is an error, not a missing metrics-server', async (_name, status, data) => {
    for (const [, call] of calls) {
      answering(status, data)
      expect(isMetricsUnavailableError(await failureOf(call))).toBe(false)
    }
  })

  it('a request that got no answer is an error, not a missing metrics-server', () => {
    expect(isMetricsUnavailableError(new Error('Network Error'))).toBe(false)
    expect(isMetricsUnavailableError(undefined)).toBe(false)
  })
})
