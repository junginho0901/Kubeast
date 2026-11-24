import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import cases from '@/services/watchRows.cases.json'
import { PodDescribeTab } from './PodDescribeTab'

// A pod's describe is its row (k8s-service DescribePod, podrow.Info) with more on it: the rows here are the server's own,
// so a field the tab reads under another name shows nothing.

type Row = Record<string, string>
const rows = cases.filter((c) => c.resource === 'pods').map((c) => c.after as unknown as Row)

const tr = (_key: string, fallback: string) => fallback
const draw = (pod: object) => renderToStaticMarkup(createElement(PodDescribeTab, { data: { ...pod, events: [] }, emptyValue: '-', tr }))
const basicInformation = (pod: Row) => {
  const html = draw(pod)
  const shown = (label: string) => new RegExp(`>${label}</p><p[^>]*>([^<]*)</p>`).exec(html)?.[1]
  return { name: shown('Name'), namespace: shown('Namespace'), node: shown('Node'), phase: shown('Phase'), podIP: shown('Pod IP') }
}

describe("the Describe tab of Cluster View's pod window", () => {
  it("shows each server row's name, namespace, node, phase and pod IP", () => {
    expect(rows.filter((row) => row.node_name && row.pod_ip).length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(basicInformation(row)).toEqual({
        name: row.name, namespace: row.namespace, node: row.node_name, phase: row.phase, podIP: row.pod_ip || undefined,
      })
    }
  })

  it('shows "-" as the node of a pod that is not scheduled yet', () => {
    expect(basicInformation({ ...rows[0], node_name: '' }).node).toBe('-')
  })

  it("shows each container's restart count, 0 for one with no status yet", () => {
    const restarts = (pod: object) => [...draw(pod).matchAll(/Restart Count: <\/span><span[^>]*>([^<]*)</g)].map((m) => m[1])
    const pods = rows as unknown as { containers: { name: string; image: string; restart_count: number }[] }[]
    expect(pods.some((pod) => pod.containers.some((c) => c.restart_count > 0))).toBe(true)
    for (const pod of pods) expect(restarts(pod)).toEqual(pod.containers.map((c) => String(c.restart_count)))
    // podrow.Info adds ready, restart_count and the states from the container's status
    expect(restarts({ ...rows[0], containers: [{ name: 'app', image: 'example.test/web:3' }] })).toEqual(['0'])
  })
})
