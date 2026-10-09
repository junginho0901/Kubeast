import { describe, expect, it } from 'vitest'
import { flattenApiResources } from './apiResources'

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
