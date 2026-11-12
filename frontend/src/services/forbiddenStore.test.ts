import { beforeEach, describe, expect, it } from 'vitest'
import { forbiddenLabels, forgetRefusedElsewhere, recordForbidden, resetForbidden } from './forbiddenStore'

// Codex QA Q11: a namespace the page refused, then one it may read — the list shows its rows and the banner still
// said "no permission to view ConfigMap". A refusal in a namespace goes when the page reads the kind where it now is.
describe('forbiddenStore', () => {
  beforeEach(() => resetForbidden())

  it('forgets a namespace the page left once the kind answers in the one it shows', () => {
    recordForbidden('/cluster/namespaces/other-team/configmaps')
    expect(forbiddenLabels()).toEqual(['ConfigMap'])
    forgetRefusedElsewhere('/cluster/namespaces/my-team/configmaps?cluster=default', 'my-team')
    expect(forbiddenLabels()).toEqual([])
  })

  it('forgets it when every namespace is shown and read', () => {
    recordForbidden('/cluster/namespaces/other-team/configmaps')
    forgetRefusedElsewhere('/cluster/configmaps/all', 'all')
    expect(forbiddenLabels()).toEqual([])
  })

  it('keeps it while the page still shows that namespace or reads another it did not choose', () => {
    recordForbidden('/cluster/namespaces/a/configmaps')
    forgetRefusedElsewhere('/cluster/namespaces/b/configmaps', 'a')
    forgetRefusedElsewhere('/cluster/namespaces/b/configmaps', 'all')
    forgetRefusedElsewhere('/cluster/namespaces/b/configmaps', 'a,b')
    expect(forbiddenLabels()).toEqual(['ConfigMap'])
  })

  it('keeps a refusal across the cluster and other kinds', () => {
    recordForbidden('/cluster/nodes')
    recordForbidden('/cluster/namespaces/a/secrets')
    recordForbidden('/cluster/namespaces/a/configmaps')
    forgetRefusedElsewhere('/cluster/namespaces/b/configmaps', 'b')
    expect(forbiddenLabels()).toEqual(['Node', 'Secret'])
    forgetRefusedElsewhere('/cluster/nodes', 'b')
    expect(forbiddenLabels()).toEqual(['Node', 'Secret'])
  })

  it('a refusal again in the namespace shown stays', () => {
    recordForbidden('/cluster/namespaces/a/configmaps')
    forgetRefusedElsewhere('/cluster/namespaces/b/configmaps', 'b')
    recordForbidden('/cluster/namespaces/b/configmaps')
    expect(forbiddenLabels()).toEqual(['ConfigMap'])
  })
})
