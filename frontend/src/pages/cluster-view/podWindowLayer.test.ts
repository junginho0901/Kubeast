import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import rowCases from '@/services/watchRows.cases.json'
import { enforceTokenBudget } from '@/utils/aiContext/tokenBudget'
import { ClusterViewContext, type ClusterViewContextValue } from './ClusterViewContext'
import { getHealthIcon } from './podHealth'
import { podToDetail, type DetailTab, type PodDetail } from './types'

// What the pod window tells the floating chat of the pod is what its Summary tab shows: State and Health, and the init
// containers they are read from beside the containers. The rows, and what each reads, are the server's own.

type Layer = { source?: string; summary: string; data?: Record<string, any> }
const layers = vi.hoisted(() => [] as (Layer | null)[])
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer | null) => { layers.push(input) } }))
vi.mock('@/components/ModalOverlay', () => ({ ModalOverlay: ({ children }: { children: ReactNode }) => children }))
vi.mock('./PodDetailTabs', () => ({ PodDetailTabs: () => null }))
vi.mock('./PodDetailTabBody', () => ({ PodDetailTabBody: () => null }))

import { PodDetailModal } from './PodDetailModal'
import { PodSummaryTab } from './PodSummaryTab'

const tr = (_key: string, fallback: string) => fallback
function layerOf(pod: PodDetail, o: { tab?: DetailTab; describe?: unknown; manifest?: string; reading?: boolean } = {}) {
  layers.length = 0
  const view = { selectedPod: pod, activeTab: o.tab ?? 'summary', closeDetailModal: () => {}, tr } as unknown as ClusterViewContextValue
  renderToStaticMarkup(createElement(ClusterViewContext.Provider, { value: view },
    createElement(PodDetailModal, { canExec: false, manifest: o.manifest, describeData: o.describe, podRead: o.reading ? 'reading' : 'none' })))
  return layers.at(-1)!
}
const dataOf = (pod: PodDetail, o?: Parameters<typeof layerOf>[1]) => layerOf(pod, o).data!
// as the hook registers it: within the layer's size
const sent = (layer: Layer) => JSON.parse(JSON.stringify(enforceTokenBudget({ source: 'PodDetailModal', summary: layer.summary, data: layer.data }).data))
const summaryTab = (pod: PodDetail) =>
  renderToStaticMarkup(createElement(PodSummaryTab, { pod, containerSearchQuery: '', onContainerSearchChange: () => {}, emptyValue: '-', tr }))

const rows = rowCases.filter((c) => c.resource === 'pods').map((c) => ({ name: c.name, row: c.after as any, server: (c.shows as any).health as string }))
const row = (name: string) => rows.find((r) => r.name === name)!.row
const SIDECAR_NOT_READY = row('a pod whose sidecar is up but not ready warns, as READY says')
const INIT_FAILED = row('a pod whose init container failed reads Init:Error with its restarts')
const init = (name: string, ready: boolean, state: object = { running: { started_at: '' } }) => ({ name, image: 'example.test/setup:1', ready, restart_count: 0, state })

describe("what Cluster View's pod window tells the floating chat of the pod", () => {
  it("is the State and Health the Summary tab shows of each server row, which are the server's", () => {
    expect(new Set(rows.map((r) => r.server)).size).toBeGreaterThan(5)
    for (const { name, row: pod, server } of rows) {
      const detail = podToDetail(pod)
      const { state, health } = dataOf(detail)
      expect(`${health} ${state}`, name).toBe(server)
      const html = summaryTab(detail)
      expect(/>State<\/p><p[^>]*>([^<]*)</.exec(html)?.[1], name).toBe(state)
      expect(html, name).toContain(`${renderToStaticMarkup(getHealthIcon(health, state))}<span class="text-ink font-medium">${state}<`)
    }
  })

  it('names each init container with its ready, restart count and what state it is in, a sidecar as one', () => {
    const sidecar = sent(layerOf(podToDetail(SIDECAR_NOT_READY)))
    expect(sidecar).toMatchObject({ status: 'Running', state: 'NotReady', health: 'warn', containers: [{ name: 'app', ready: true }] })
    expect(sidecar.init_containers).toEqual([{ name: 'side', ready: false, restart_count: 0, restart_policy: 'Always', state: { running: {} } }])
    const failed = sent(layerOf(podToDetail(INIT_FAILED)))
    expect(failed).toMatchObject({ state: 'Error', health: 'error' })
    expect(failed.init_containers).toEqual([{ name: 'setup', ready: false, restart_count: 4, state: { terminated: { exit_code: 1, reason: 'Error' } } }])
    const states = (...list: unknown[]) =>
      sent(layerOf(podToDetail({ ...INIT_FAILED, init_containers: list.map((state, i) => init(`i${i}`, false, state as object)) }))).init_containers.map((c: { state?: unknown }) => c.state)
    expect(states({ waiting: { reason: 'CrashLoopBackOff', message: 'back-off' } }, {}, null)).toEqual([{ waiting: { reason: 'CrashLoopBackOff' } }, undefined, undefined])
  })

  it('gives no message of an init container, so none is cut before the server masks it', () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEH'.repeat(5)}\n-----END PRIVATE KEY-----`
    const texts = ['secret "db" not found', pem, `${'e'.repeat(70)}\n${pem}`, `${'x'.repeat(299)}😀`, `${'x'.repeat(281)} ghp_0123456789abcdefghijABCDEFGHIJ012345`, 'x'.repeat(4096)]
    for (const message of texts) {
      const list = [
        { ...init('waits', false, { waiting: { reason: 'CreateContainerConfigError', message } }), last_state: { terminated: { exit_code: 1, reason: 'Error', message } } },
        init('ended', false, { terminated: { exit_code: 1, reason: 'Error', message, started_at: '', finished_at: '' } }),
      ]
      const pod = podToDetail({ ...INIT_FAILED, init_containers: list })
      for (const tab of ['summary', 'logs', 'rbac', 'manifest', 'exec', 'describe'] as const) {
        const data = dataOf(pod, { tab, manifest: 'kind: Pod' })
        expect(data.init_containers, tab).toEqual([
          { name: 'waits', ready: false, restart_count: 0, state: { waiting: { reason: 'CreateContainerConfigError' } } },
          { name: 'ended', ready: false, restart_count: 0, state: { terminated: { exit_code: 1, reason: 'Error' } } },
        ])
        expect(JSON.stringify(data.init_containers), tab).not.toContain('message')
        for (const part of [message, message.slice(0, 20), message.slice(-20)]) expect(JSON.stringify(data), tab).not.toContain(JSON.stringify(part).slice(1, -1))
      }
    }
  })

  it('gives a reason only as one short word: a runtime may write any text there', () => {
    const reasons = (reason: unknown) =>
      dataOf(podToDetail({ ...INIT_FAILED, init_containers: [init('w', false, { waiting: { reason } }), init('t', false, { terminated: { exit_code: 3, reason } })] }))
        .init_containers.map((c: { state: Record<string, { reason?: string }> }) => Object.values(c.state)[0].reason)
    for (const word of ['PodInitializing', 'CreateContainerConfigError', 'OOMKilled', 'ErrImageNeverPull', 'ContainerStatusUnknown', 'a'.repeat(40)]) {
      expect(reasons(word), word).toEqual([word, word])
    }
    for (const text of ['seccomp killed', 'password=abc', 'token: abc', 'Error\n', '\nError', '😀', 'a'.repeat(41), '', null, undefined, 3, { a: 'b' }]) {
      expect(reasons(text), String(text)).toEqual([undefined, undefined])
    }
    // the state and the exit code stay
    expect(dataOf(podToDetail({ ...INIT_FAILED, init_containers: [init('t', false, { terminated: { exit_code: 3, reason: 'seccomp killed' } })] })).init_containers[0].state)
      .toEqual({ terminated: { exit_code: 3 } })
  })

  it('says none of it until a window opened from a box has read the pod', () => {
    const box = { name: 'web-1', namespace: 'demo', node_name: 'node-a', status: 'Running', phase: 'Running', restart_count: 0, health: 'ok', health_reason: 'Running' }
    const data = sent(layerOf(podToDetail(box), { reading: true }))
    expect(data).toMatchObject({ name: 'web-1', status: 'Running', containers_loading: true })
    for (const field of ['state', 'health', 'containers', 'init_containers']) expect(data, field).not.toHaveProperty(field)
  })

  it("keeps the ones not ready when the list is cut, at the Pod drawer's five", () => {
    const inits = [...Array.from({ length: 6 }, (_, i) => init(`done-${i}`, true)), init('last', false)]
    const names = (pod: object) => dataOf(podToDetail(pod)).init_containers.map((c: { name: string }) => c.name)
    expect(names({ ...SIDECAR_NOT_READY, init_containers: inits })).toEqual(['last', 'done-0', 'done-1', 'done-2', 'done-3'])
    expect(names({ ...SIDECAR_NOT_READY, init_containers: [] })).toEqual([])
  })

  it('does not repeat them beside the describe answer, which has them whole', () => {
    const pod = podToDetail(INIT_FAILED)
    expect(dataOf(pod, { tab: 'describe', describe: INIT_FAILED }).init_containers).toBeUndefined()
    expect(dataOf(pod, { tab: 'describe', describe: INIT_FAILED })).toMatchObject({ state: 'Error', describe: { init_containers: [{ name: 'setup' }] } })
    expect(dataOf(pod, { tab: 'describe' }).init_containers).toHaveLength(1)
    expect(dataOf(pod, { tab: 'logs', describe: INIT_FAILED }).init_containers).toHaveLength(1)
  })

  // the pod of a layer near its size: what a container's message and the manifest leave
  const image = 'registry.example.test/team/service-name:2026.11.24-abcdef0'
  const main = (n: number, state: object) => ({ name: `app-${n}`, image, ready: false, restart_count: 3, state })
  const ended = (message: string) => ({ terminated: { exit_code: 1, reason: 'Error', message, started_at: '2026-11-24T10:00:00Z', finished_at: '2026-11-24T10:00:03Z' } })
  const done = (n: number, message = '') => ({ ...init(`init-${n}`, true, { terminated: { exit_code: 0, reason: 'Completed', message } }) })
  const crashing = (n: number) => ({ ...init(`init-${n}`, false, { waiting: { reason: 'CrashLoopBackOff', message: '가'.repeat(400) } }), restart_count: 7 })
  const waiting = (n: number) => init(`init-${n}`, false, { waiting: { reason: 'PodInitializing', message: '' } })
  const podOf = (containers: object[], init_containers: object[]) => podToDetail({
    name: 'web-6d4cf56db6-abcde', namespace: 'shop', node_name: 'ip-10-80-1-23.ap-northeast-2.compute.internal', status: 'Init:CrashLoopBackOff', phase: 'Pending',
    restart_count: 7, created_at: '2026-11-24T10:00:00Z', containers, init_containers,
  })
  const MANIFEST = '        - name: SOME_ENV_VALUE\n          value: "something"\n'.repeat(200)
  const bytes = (data: unknown) => new Blob([JSON.stringify(data)]).size
  // what is sent of the layer, and of the same layer without the State, Health and init containers
  function besides(pod: PodDetail, manifest?: string) {
    const layer = layerOf(pod, manifest ? { tab: 'manifest', manifest } : {})
    const { state: _state, health: _health, init_containers: _inits, ...rest } = layer.data!
    return { now: sent(layer), without: sent({ ...layer, data: rest }) }
  }

  it.each([
    ['3 containers, 2 init containers done and 1 crashing', [1, 2, 3].map((n) => main(n, { running: { started_at: '' } })), [done(0), done(1), crashing(2)], MANIFEST, 3],
    ['3 containers, 1 init container crashing and 4 waiting', [1, 2, 3].map((n) => main(n, { running: { started_at: '' } })), [crashing(0), ...[1, 2, 3, 4].map(waiting)], MANIFEST, 5],
    ['a container that ended on 2,048 bytes, 2 init containers done', [main(1, ended('E'.repeat(2048)))], [done(0), done(1)], MANIFEST, 2],
    ['a container that ended on 3,000 bytes, 1 init container done', [main(1, ended('E'.repeat(3000)))], [done(0)], MANIFEST, undefined],
    ['a container that ended on 3,150 bytes, 1 init container done on 400 characters', [main(1, ended('E'.repeat(3150)))], [done(0, 'm'.repeat(400))], MANIFEST, undefined],
    ['6 containers that cannot pull, 3 init containers done',
      Array.from({ length: 6 }, (_, n) => main(n, { waiting: { reason: 'ImagePullBackOff', message: `Back-off pulling image ${'x'.repeat(380)}` } })), [done(0), done(1), done(2)], MANIFEST, undefined],
    ['a Korean manifest, 1 init container done', [1, 2, 3].map((n) => main(n, { running: { started_at: '' } })), [done(0)], '        description: "결제 서비스 설정 값 설명"\n'.repeat(200), 1],
    ['2 containers that ended on 3,800 bytes, 5 init containers crashing', [main(1, ended('E'.repeat(3800))), main(2, ended('E'.repeat(3800)))], [0, 1, 2, 3, 4].map(crashing), undefined, 5],
    ['a container that ended on 4,096 bytes, 5 init containers crashing', [main(1, ended('E'.repeat(4096)))], [0, 1, 2, 3, 4].map(crashing), undefined, 5],
  ])("keeps every container a layer of its size keeps: %s", (_name, containers, inits, manifest, given) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { now, without } = besides(podOf(containers, inits), manifest)
    expect(now.__truncated__).toBeUndefined()
    expect(bytes(now)).toBeLessThanOrEqual(8192)
    expect(now.containers).toEqual(without.containers)
    if (given !== undefined) expect(now.init_containers).toHaveLength(given)
  })

  it('gives way where the layer is nearly full: the init containers that are done, the others, then State and Health', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const steps = new Set<string>()
    for (let length = 2400; length < 3500; length += 1) {
      const { now, without } = besides(podOf([main(1, ended('E'.repeat(length))), main(2, { running: { started_at: '' } })], [done(0), crashing(1), done(2)]), MANIFEST)
      expect(now.__truncated__, String(length)).toBe(without.__truncated__)
      expect(now.containers, String(length)).toEqual(without.containers)
      if (now.__truncated__) continue
      expect(bytes(now)).toBeLessThanOrEqual(8192)
      steps.add(`${now.init_containers?.map((c: { name: string }) => c.name).join() ?? '-'} ${now.state ?? '-'} ${now.health ?? '-'}`)
    }
    expect([...steps]).toEqual(['init-1,init-0,init-2 CrashLoopBackOff error', 'init-1 CrashLoopBackOff error', '- CrashLoopBackOff error', '- - -'])
  })
})
