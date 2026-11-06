import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { PageContextProvider } from '@/components/PageContextProvider'
import { podTableStatus } from '@/pages/workloads/pods/podHelpers'
import ConfigMapInfo from './ConfigMapInfo'
import { namespacePodsLayer } from './namespacePods'

const HERE = fileURLToPath(new URL('.', import.meta.url))

const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name)
  return e.isDirectory() ? sources(p) : /\.tsx$/.test(e.name) ? [p] : []
})

// The Status of a drawer's pod table is kubectl's word, the one the Pods list shows, not the pod's phase.
describe('a drawer pod table\'s Status', () => {
  it('reads the Status before the phase', () => {
    expect(podTableStatus({ status: 'CrashLoopBackOff', phase: 'Running' })).toBe('CrashLoopBackOff')
    expect(podTableStatus({ status: 'Terminating', phase: 'Running' })).toBe('Terminating')
  })

  it('falls back to the phase, then to "-"', () => {
    expect(podTableStatus({ phase: 'Pending' })).toBe('Pending')
    expect(podTableStatus({ status: null, phase: 'Pending' })).toBe('Pending')
    expect(podTableStatus({})).toBe('-')
    expect(podTableStatus(null)).toBe('-')
  })

  it('no drawer badge reads the phase first', () => {
    const phaseFirst = /StatusBadge status=\{String\(\(?\w+(?: as any\))?\.phase\b/
    const bad = sources(HERE).filter((f) => phaseFirst.test(readFileSync(f, 'utf8'))).map((f) => relative(HERE, f))
    expect(bad).toEqual([])
  })

  it('a ConfigMap\'s Used By Pods shows the pod\'s kubectl Status', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(['configmap-describe', 'ns', 'cm'], { data_keys: [] })
    qc.setQueryData(['cm-used-by-pods', 'ns', 'cm'], [
      { name: 'p1', namespace: 'ns', phase: 'Running', status: 'CrashLoopBackOff', config_map_refs: ['cm'] },
      { name: 'p2', namespace: 'ns', phase: 'Running', status: 'Terminating', config_map_refs: ['cm'] },
    ])
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: qc },
      createElement(MemoryRouter, null, createElement(PageContextProvider, null, createElement(ConfigMapInfo, { name: 'cm', namespace: 'ns' })))))
    const cells = [...html.matchAll(/class="badge [\w-]+"[^>]*>([^<]+)</g)].map((m) => m[1])
    expect(cells).toEqual(['CrashLoopBackOff', 'Terminating'])
  })

  // the Namespace drawer's pod table shows the Status: the floating chat gets it beside the phase
  it('reaches the floating chat with the Namespace drawer\'s pods', () => {
    const [pod] = namespacePodsLayer([{ name: 'web', status: 'CrashLoopBackOff', phase: 'Running' }], 'shop').items
    expect(pod).toMatchObject({ status: 'CrashLoopBackOff', phase: 'Running' })
  })
})
