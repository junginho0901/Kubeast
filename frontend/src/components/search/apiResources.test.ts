import { describe, expect, it } from 'vitest'
import { flattenApiResources, withSearchTypes } from './apiResources'

// N3-b 8: the picker kept one entry per name, so events.k8s.io Events and a second group's widgets could not be
// searched, and the server resolves a bare name to one group.
describe('withSearchTypes', () => {
  const opt = (name: string, kind: string, group: string) => ({ name, kind, group, namespaced: true })
  it('names a type by its name, or name.group when another group serves the same name (core keeps the bare name)', () => {
    const types = withSearchTypes([
      opt('pods', 'Pod', 'core'),
      opt('events', 'Event', 'core'),
      opt('pods', 'Pod', 'core'),
      opt('events', 'Event', 'events.k8s.io'),
      opt('pods', 'PodMetrics', 'metrics.k8s.io'),
      opt('widgets', 'Widget', 'qa.example.com'),
      opt('widgets', 'Widget', 'numbers.kubeast.io'),
      opt('modelconfigs', 'ModelConfig', 'ai.kubeast.io'),
    ]).map((o) => `${o.kind} ${o.type}`)
    expect(types).toEqual([
      'Pod pods',
      'Event events',
      'Event events.events.k8s.io',
      'PodMetrics pods.metrics.k8s.io',
      'Widget widgets.qa.example.com',
      'Widget widgets.numbers.kubeast.io',
      'ModelConfig modelconfigs',
    ])
  })
})

// Re-QA #36: the picker read flat keys from discovery's grouped lists, so no
// extension resource reached it and the group was always "core".
describe('flattenApiResources', () => {
  const lists = [
    {
      groupVersion: 'autoscaling/v2',
      resources: [
        { name: 'horizontalpodautoscalers', kind: 'HorizontalPodAutoscaler', namespaced: true, verbs: ['list', 'get'] },
        { name: 'horizontalpodautoscalers/status', kind: 'HorizontalPodAutoscaler', namespaced: true, verbs: ['get'] },
      ],
    },
    {
      groupVersion: 'ai.kubeast.io/v1alpha1',
      resources: [{ name: 'modelconfigs', kind: 'ModelConfig', namespaced: false, verbs: ['list'] }],
    },
    { groupVersion: 'v1', resources: [{ name: 'pods', kind: 'Pod', namespaced: true, verbs: ['list'] }] },
    {
      groupVersion: 'autoscaling/v1',
      resources: [{ name: 'horizontalpodautoscalers', kind: 'HorizontalPodAutoscaler', namespaced: true, verbs: ['list'] }],
    },
  ]

  it('keeps each resource once under its API group, without subresources', () => {
    expect(flattenApiResources(lists)).toEqual([
      { name: 'horizontalpodautoscalers', kind: 'HorizontalPodAutoscaler', group: 'autoscaling', namespaced: true, verbs: ['list', 'get'] },
      { name: 'modelconfigs', kind: 'ModelConfig', group: 'ai.kubeast.io', namespaced: false, verbs: ['list'] },
      { name: 'pods', kind: 'Pod', group: 'core', namespaced: true, verbs: ['list'] },
    ])
  })

  it('ignores entries that are not lists', () => {
    expect(flattenApiResources([{}, { groupVersion: 'apps/v1' }])).toEqual([])
  })
})
