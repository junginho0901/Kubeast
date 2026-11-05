import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/services/api'
import { client } from '@/services/api/client'
import type { OptimizationRow } from '@/services/api/types'
import { optimizationResizeRequest } from './utils'

// An Optimization row's "Apply without restart" sends the row's workload apiVersion, so the server resizes the pods of
// that group's owner only (a StatefulSet of apps/v1 and one of OpenKruise's apps.kruise.io can share a name).

afterEach(() => vi.restoreAllMocks())

const row = (r: Partial<OptimizationRow>): OptimizationRow => ({
  kind: 'StatefulSet', namespace: 'shop', name: 'web', container: 'app', pods: 2, cpu_request_m: 50, cpu_limit_m: 0,
  mem_request_bytes: 200 << 20, mem_limit_bytes: 0, flags: [], cpu_recommend_m: 10, mem_recommend_bytes: 100 << 20, ...r,
})

describe('Optimization resize', () => {
  it('the request names the row\'s workload, container, recommendation and apiVersion', () => {
    expect(optimizationResizeRequest(row({ api_version: 'apps.kruise.io/v1beta1' }))).toEqual({
      kind: 'StatefulSet', name: 'web', container: 'app', cpu_request_m: 10, mem_request_bytes: 100 << 20, api_version: 'apps.kruise.io/v1beta1',
    })
  })

  it('a row without an apiVersion (an older server) posts the body as before', async () => {
    const post = vi.spyOn(client, 'post').mockResolvedValue({ data: {} })
    await api.resizeOptimization('shop', optimizationResizeRequest(row({ cpu_recommend_m: undefined })))
    expect(post.mock.calls).toEqual([['/cluster/namespaces/shop/optimization/resize', { kind: 'StatefulSet', name: 'web', container: 'app', cpu_request_m: undefined, mem_request_bytes: 100 << 20, api_version: undefined }]])
    expect(JSON.parse(JSON.stringify(post.mock.calls[0][1]))).toEqual({ kind: 'StatefulSet', name: 'web', container: 'app', mem_request_bytes: 100 << 20 })
  })

  it('the window\'s Apply sends that request', () => {
    const src = readFileSync(fileURLToPath(new URL('./modals/OptimizationModal.tsx', import.meta.url)), 'utf8')
    expect(src).toContain('mutationFn: (row: OptimizationRow) => api.resizeOptimization(row.namespace, optimizationResizeRequest(row)),')
  })
})
