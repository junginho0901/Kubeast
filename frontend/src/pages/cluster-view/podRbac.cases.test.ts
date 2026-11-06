import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PodRbacTab } from './PodRbacTab'
import { buildRbacPermissionSummary } from './rbacUtils'
import cases from './podRbac.cases.json'

type Layer = { summary: string; data?: Record<string, any> } | null

const state = vi.hoisted(() => ({
  query: { data: undefined as unknown, isLoading: false, error: null as unknown },
  include: false,
  layer: null as unknown,
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => state.query,
  keepPreviousData: (previous: unknown) => previous,
}))
vi.mock('@/services/api', () => ({ api: {} }))
vi.mock('@/hooks/useAIContext', () => ({
  useAIContext: (input: unknown) => {
    state.layer = input
  },
}))
vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return {
    ...real,
    useState: (initial: unknown) => [typeof initial === 'boolean' ? state.include : initial, () => undefined],
  }
})

// k8s-service writes these answers from its stand-in cluster (internal/handler/pods_rbac_test.go TestPodRBACFixture),
// each with what the tab must draw for it, so the two sides cannot name a field differently.

const tr = (_key: string, fallback: string, options?: Record<string, any>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''))

const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

const draw = (answer: unknown, include: boolean) => {
  state.query = { data: answer, isLoading: false, error: null }
  state.include = include
  state.layer = null
  return renderToStaticMarkup(createElement(PodRbacTab, { pod: { name: 'web-1', namespace: 'shop' }, tr }))
}

// the part of the page from one section to the next; the page draws them in this order
const SECTIONS = ['pod-rbac-summary', 'pod-rbac-role-bindings', 'pod-rbac-cluster-role-bindings']
const sectionOf = (html: string, id: string) => {
  const start = html.indexOf(`data-testid="${id}"`)
  if (start < 0) return ''
  const after = SECTIONS[SECTIONS.indexOf(id) + 1]
  const next = after ? html.indexOf(`data-testid="${after}"`, start) : -1
  return html.slice(start, next < 0 ? undefined : next)
}

const namesIn = (section: string) =>
  [...section.matchAll(/data-testid="pod-rbac-binding-name"[^>]*>([^<]*)</g)].map((m) => m[1]).sort()

const rowsOf = (answer: unknown) => {
  const { resourceItems, nonResourceItems } = buildRbacPermissionSummary(answer)
  return {
    resources: resourceItems.map((i) => `${i.apiGroup}|${i.resource}|${(i.resourceNames ?? []).join(',')}|${i.verbsList.join(',')}`),
    non_resources: nonResourceItems.map((i) => `${i.nonResourceURL}|${i.verbsList.join(',')}`),
  }
}

const caseNamed = (name: string) => {
  const found = cases.find((c) => c.name === name)
  if (!found) throw new Error(`no case ${name}`)
  return found
}

describe('the RBAC tab draws what k8s-service answers', () => {
  beforeEach(() => {
    state.include = false
  })

  for (const c of cases) {
    const count = (names: string[] | null) => (names === null ? '-' : names.length)

    describe(c.name, () => {
      it('names the pod\'s ServiceAccount', () => {
        const text = textOf(draw(c.answer, c.include_authenticated))
        expect(text).toContain(`system:serviceaccount:shop:${c.want.service_account}`)
      })

      it('counts the bindings, and draws no number for a list it did not read', () => {
        const text = textOf(draw(c.answer, c.include_authenticated))
        expect(text).toContain(`RoleBinding ${count(c.want.role_bindings)}`)
        expect(text).toContain(`ClusterRoleBinding ${count(c.want.cluster_role_bindings)}`)
      })

      it('lists each binding in its own section', () => {
        const html = draw(c.answer, c.include_authenticated)
        expect(namesIn(sectionOf(html, 'pod-rbac-role-bindings'))).toEqual(c.want.role_bindings ?? [])
        expect(namesIn(sectionOf(html, 'pod-rbac-cluster-role-bindings'))).toEqual(c.want.cluster_role_bindings ?? [])
      })

      it('says "None" only for a list it read, and the cluster\'s refusal for one it did not', () => {
        const html = draw(c.answer, c.include_authenticated)
        const answer = c.answer as Record<string, any>
        for (const [section, want, error] of [
          ['pod-rbac-role-bindings', c.want.role_bindings, answer.role_bindings_error],
          ['pod-rbac-cluster-role-bindings', c.want.cluster_role_bindings, answer.cluster_role_bindings_error],
        ] as const) {
          const text = textOf(sectionOf(html, section))
          if (want === null) {
            expect(text).toContain(error)
            expect(text).not.toContain('None')
          } else if (want.length === 0) {
            expect(text).toContain('None')
          }
        }
      })

      it('sums the rules it could read into the permission summary', () => {
        expect(rowsOf(c.answer)).toEqual({ resources: c.want.resources, non_resources: c.want.non_resources })
      })

      it('says when the summary may lack permissions, and never "None" then', () => {
        const summary = textOf(sectionOf(draw(c.answer, c.include_authenticated), 'pod-rbac-summary'))
        const total = c.want.resources.length + c.want.non_resources.length
        const incomplete = /could not be read/.test(summary)
        expect(incomplete).toBe(c.want.incomplete)
        if (c.want.incomplete && total === 0) {
          expect(summary).not.toContain('None')
          expect(summary).not.toContain('0 items')
        } else if (total === 0) {
          expect(summary).toContain('None')
          expect(summary).toContain('0 items')
        } else {
          expect(summary).toContain(`${total} items`)
        }
      })

      it('warns once for each thing the cluster refused', () => {
        const html = draw(c.answer, c.include_authenticated)
        expect([...html.matchAll(/data-testid="pod-rbac-warning"/g)].length).toBe(c.want.warnings)
      })

      it('tells the floating chat what it shows', () => {
        draw(c.answer, c.include_authenticated)
        const layer = state.layer as Layer
        expect(layer?.data?.service_account).toBe(`system:serviceaccount:shop:${c.want.service_account}`)
        const names = (key: string) => {
          const rows = layer?.data?.[key] as { name: string }[] | undefined
          return rows === undefined ? null : rows.map((r) => r.name).sort()
        }
        expect(names('role_bindings')).toEqual(c.want.role_bindings)
        expect(names('cluster_role_bindings')).toEqual(c.want.cluster_role_bindings)
        expect(layer?.data?.permissions_incomplete).toBe(c.want.incomplete)
        const rows = rowsOf(c.answer)
        expect(layer?.data?.permissions).toEqual([...rows.resources, ...rows.non_resources])
      })
    })
  }

  it('says what a binding matched by', () => {
    const text = textOf(draw(caseNamed('bound by name, by user name and by group').answer, false))
    expect(text).toContain('Matching: Group(system:serviceaccounts:shop)')
    expect(text).toContain('Matching: Group(system:serviceaccounts)')
    expect(text).toContain('Matching: User(system:serviceaccount)')
    expect(text).toContain('Matching: ServiceAccount (direct)')
  })

  it('draws a broad binding\'s rules whole, its URLs and resource names too', () => {
    const c = caseNamed('with the broad group')
    const clusterSection = sectionOf(draw(c.answer, true), 'pod-rbac-cluster-role-bindings')
    const rules = clusterSection.split('data-testid="pod-rbac-rule"').slice(1).map(textOf)
    const version = rules.find((r) => r.includes('/version'))
    expect(version).toBeDefined()
    // A rule of URLs has no API group or resource to name.
    expect(version).not.toContain('(core)')
    expect(version).not.toContain('resources None')
  })

  it('names each API group of a rule, the core group as (core)', () => {
    const c = caseNamed('bound by name, by user name and by group')
    const section = sectionOf(draw(c.answer, false), 'pod-rbac-role-bindings')
    const rules = section.split('data-testid="pod-rbac-rule"').slice(1).map(textOf)
    expect(rules.find((r) => r.includes('events'))).toContain('(core), batch')
    expect(rules.find((r) => r.includes('configmaps'))).toContain('resourceNames app-config, app-flags')
  })

  it('says a role has no rules, and no count for a role it could not read', () => {
    const empty = textOf(draw(caseNamed('a role without rules').answer, false))
    expect(empty).toContain('rules: 0')
    expect(empty).toContain('Rules None')
    const refused = textOf(sectionOf(draw(caseNamed('the cluster refused one list and one role').answer, false), 'pod-rbac-role-bindings'))
    expect(refused).toContain('rules: -')
    expect(refused).toContain('resolve failed')
    expect(refused).toContain('is forbidden')
    expect(refused).not.toContain('rules: 0')
  })

  it('leaves the broad group\'s bindings out of the normal list', () => {
    const c = caseNamed('with the broad group')
    const html = draw(c.answer, true)
    const broad = textOf(sectionOf(html, 'pod-rbac-cluster-role-bindings'))
    expect(broad).toContain('Broad ClusterRoleBinding 1 (system:authenticated)')
    expect(textOf(html)).toContain('ClusterRoleBinding 5 (broad 1)')
  })

  it('names what the cluster said when the whole read failed', () => {
    state.query = { data: undefined, isLoading: false, error: { response: { data: { detail: 'pods "web-1" is forbidden' } } } }
    const text = textOf(renderToStaticMarkup(createElement(PodRbacTab, { pod: { name: 'web-1', namespace: 'shop' }, tr })))
    expect(text).toContain('pods "web-1" is forbidden')
  })
})
