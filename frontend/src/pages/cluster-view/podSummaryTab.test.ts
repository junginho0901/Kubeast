import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import rowCases from '@/services/watchRows.cases.json'
import { PodSummaryTab } from './PodSummaryTab'
import { filledDetail } from './podDetailRead'
import healthCases from './podHealth.cases.json'
import { boxPodHealth, getHealthIcon } from './podHealth'
import { podToDetail, type PodDetail } from './types'

// The Summary tab's State and Health are the words and the icon of the pod's card: one rule (getPodHealth) reads both, the
// card's from the server's row and the tab's from the window's pod. The rows, and what each reads, are the server's own.

const rows = rowCases.filter((c) => c.resource === 'pods').map((c) => ({ name: c.name, row: c.after as any, server: (c.shows as any).health as string }))

const tr = (_key: string, fallback: string) => fallback
const summary = (pod: PodDetail) => {
  const html = renderToStaticMarkup(createElement(PodSummaryTab, { pod, containerSearchQuery: '', onContainerSearchChange: () => {}, emptyValue: '-', tr }))
  const [, icon, health] = />Health<\/h3><div[^>]*>(.*?)<span class="text-ink[^"]*">([^<]*)<\/span>/.exec(html) ?? []
  return { state: />State<\/p><p[^>]*>([^<]*)</.exec(html)?.[1], health, icon }
}
// as PodNodeGrid draws the card
const card = (row: any) => {
  const { level, reason } = boxPodHealth(row)
  return { state: reason, health: reason, icon: renderToStaticMarkup(getHealthIcon(level, reason)) }
}
const apart = (shown: { name: string; summary: unknown; card: unknown }[]) =>
  shown.filter((s) => JSON.stringify(s.summary) !== JSON.stringify(s.card))

describe("the Summary tab of Cluster View's pod window", () => {
  it("says the card's state and health of each server row, which are the server's", () => {
    for (const { name, row, server } of rows) {
      const { level, reason } = boxPodHealth(row)
      expect(`${level} ${reason}`, name).toBe(server)
    }
    expect(new Set(rows.map((r) => r.server))).toEqual(new Set([
      'ok Running', 'warn Terminating', 'warn NotReady', 'warn PodInitializing', 'error CrashLoopBackOff', 'error Error', 'error Failed',
    ]))
    expect(apart(rows.map(({ name, row }) => ({ name, summary: summary(podToDetail(row)), card: card(row) })))).toEqual([])
  })

  it("says what the box's card says once a window opened from it has read the pod", () => {
    const named = { name: 'web-1', namespace: 'demo' }
    expect(healthCases.length).toBeGreaterThan(500)
    expect(apart(healthCases.map((c, i) => {
      const box = { ...named, ...c.box }
      const opened = podToDetail(box)
      const read = { data: { ...named, ...c.pod }, dataAt: opened.openedAt!, error: null, errorAt: 0 }
      const filled = filledDetail(opened, read, { activeTab: 'summary', selectedContainer: '', execContainer: '' })
      return { name: `${i}: ${c.level} ${c.reason}`, summary: summary(filled!.pod), card: card(box) }
    }))).toEqual([])
  })
})
