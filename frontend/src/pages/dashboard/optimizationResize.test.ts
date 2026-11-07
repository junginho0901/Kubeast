import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/services/api'
import { client } from '@/services/api/client'
import type { OptimizationRow } from '@/services/api/types'
import { optimizationApply, optimizationResizeRequest } from './utils'

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

// The server resizes the pods of the kinds it names (k8s ResizeKindAllowed, sent as resize_kinds): a row of another
// owner gets the reason, not a button the server answers with a 400.
describe('Optimization Apply', () => {
  const KINDS = ['CronJob', 'DaemonSet', 'Deployment', 'Job', 'Pod', 'ReplicaSet', 'StatefulSet']

  it('is offered on a row of a kind the server resizes', () => {
    for (const kind of KINDS) expect(optimizationApply(row({ kind }), true, KINDS), kind).toBe('apply')
  })

  it('is refused with a reason on another owner\'s row', () => {
    expect(optimizationApply(row({ kind: 'Widget', api_version: 'qa.example.com/v1' }), true, KINDS)).toBe('kind')
    expect(optimizationApply(row({ kind: 'Rollout', api_version: 'argoproj.io/v1alpha1' }), true, KINDS)).toBe('kind')
  })

  it('says nothing on a row with nothing to apply, or for a user who cannot apply', () => {
    expect(optimizationApply(row({ kind: 'Widget', cpu_recommend_m: 50, mem_recommend_bytes: 200 << 20 }), true, KINDS)).toBeNull()
    expect(optimizationApply(row({ cpu_recommend_m: undefined, mem_recommend_bytes: undefined }), true, KINDS)).toBeNull()
    expect(optimizationApply(row({ kind: 'Widget' }), false, KINDS)).toBeNull()
    expect(optimizationApply(row({}), false, KINDS)).toBeNull()
  })

  it('leaves the answer to the server when it names no kinds', () => {
    expect(optimizationApply(row({ kind: 'Widget' }), true, undefined)).toBe('apply')
  })

  it('the window and the floating chat read it', () => {
    const src = readFileSync(fileURLToPath(new URL('./modals/OptimizationModal.tsx', import.meta.url)), 'utf8')
    expect(src).toContain('const applyOf = (row: OptimizationRow) => optimizationApply(row, canResize, table?.resize_kinds)')
    expect(src).toContain('data-testid="optimization-resize-kind"')
    expect(src).toContain("apply: optimizationApply(r, canResize, table.resize_kinds)")
  })
})
