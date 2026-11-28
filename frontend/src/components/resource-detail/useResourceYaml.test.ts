import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CASES from './yamlOpened.cases.json'
import { keepSameRead } from '@/utils/keepSameRead'
import { YAML_NONCE_AT, useResourceYaml } from './useResourceYaml'
import { encodeSecretYaml, yamlOpenedOf } from './utils'

const api = vi.hoisted(() => ({
  getResourceYaml: vi.fn(async (type: string) => ({ yaml: `read as ${type}` })),
  applyResourceYaml: vi.fn(async () => ({ status: 'ok' })),
  applyNodeYaml: vi.fn(async () => ({ status: 'ok' })),
  applyNamespaceYaml: vi.fn(async () => ({ status: 'ok' })),
}))
vi.mock('@/services/api', () => ({ api }))

// The hook of a drawer showing this object.
function save(kind: string, namespace: string | null, rawJson?: Record<string, unknown>) {
  let handle!: ReturnType<typeof useResourceYaml>['handleApplyYaml']
  const Window = () => {
    handle = useResourceYaml({ target: { kind, namespace, name: 'x', rawJson }, tab: 'info', canEditYaml: true }).handleApplyYaml
    return null
  }
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Window)))
  return handle
}

const OPENED = 'kind: X\nmetadata:\n  name: x\n  labels:\n    gone: a\n    keep: b\n'
const EDITED = 'kind: X\nmetadata:\n  name: x\n  labels:\n    keep: b\n'
const SENT = { head: 4, tail: 2, lines: ['    gone: a'] }

beforeEach(() => {
  api.applyResourceYaml.mockClear()
  api.applyNodeYaml.mockClear()
  api.applyNamespaceYaml.mockClear()
})

describe('a save of a YAML window', () => {
  it('sends a kind the text its edit began from, as what the two do not share', async () => {
    await save('ConfigMap', 'shop')(EDITED, OPENED)
    expect(api.applyResourceYaml).toHaveBeenCalledWith('configmap', 'x', EDITED, 'shop', SENT)
  })

  it('and a Node', async () => {
    await save('Node', null)(EDITED, OPENED)
    expect(api.applyNodeYaml).toHaveBeenCalledWith('x', EDITED, SENT)
  })

  it('and a Namespace', async () => {
    await save('Namespace', null)(EDITED, OPENED)
    expect(api.applyNamespaceYaml).toHaveBeenCalledWith('x', EDITED, SENT)
  })

  it('and a kind of a group, by its group: another group may serve the same Kind', async () => {
    await save('BackendTLSPolicy', 'shop')(EDITED, OPENED)
    expect(api.applyResourceYaml).toHaveBeenCalledWith('backendtlspolicies.gateway.networking.k8s.io', 'x', EDITED, 'shop', SENT)
  })

  it('and a CustomResourceDefinition', async () => {
    await save('CustomResourceDefinition', null)(EDITED, OPENED)
    expect(api.applyResourceYaml).toHaveBeenCalledWith('customresourcedefinitions', 'x', EDITED, undefined, SENT)
  })

  it('and a custom resource', async () => {
    await save('CustomResourceInstance', 'shop', { crd_name: 'widgets.example.test' })(EDITED, OPENED)
    expect(api.applyResourceYaml).toHaveBeenCalledWith('widgets.example.test', 'x', EDITED, 'shop', SENT)
  })

  it('and a Secret, both texts as it saves them, so a value left alone is no difference', async () => {
    const opened = "kind: Secret\nstringData:\n  a: '***'\n  b: fake-value\n"
    const edited = "kind: Secret\nstringData:\n  b: fake-value\n"
    await save('Secret', 'shop')(edited, opened)
    expect(api.applyResourceYaml).toHaveBeenCalledWith('secret', 'x', encodeSecretYaml(edited), 'shop', yamlOpenedOf(encodeSecretYaml(opened), encodeSecretYaml(edited)))
  })

  it('sends none when it has no such text', async () => {
    await save('ConfigMap', 'shop')(EDITED)
    expect(api.applyResourceYaml).toHaveBeenCalledWith('configmap', 'x', EDITED, 'shop', undefined)
  })
})

// k8s-service puts the text back from these (handler TestTheOpenedTextIsPutBackFromWhatTheScreenSends, the same cases).
describe('what a save sends of the text its edit began from', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(yamlOpenedOf(c.opened, c.edited)).toEqual({ head: c.head, tail: c.tail, lines: c.lines })
  })
})

// Two CRDs may serve objects of one namespace and name (Karpenter's NodePool and EC2NodeClass "default"). The drawer's
// YAML tab moving from one to the other within the read's stale time shows and hands the floating chat the YAML of
// the object it now names, never the one before.
describe('the YAML of a custom resource', () => {
  const NODEPOOL = { kind: 'NodePool', group: 'karpenter.sh', version: 'v1', crd_name: 'nodepools.karpenter.sh' }
  const NODECLASS = { kind: 'EC2NodeClass', group: 'karpenter.k8s.aws', version: 'v1', crd_name: 'ec2nodeclasses.karpenter.k8s.aws' }

  function shown(client: QueryClient, rawJson: Record<string, unknown>) {
    let yaml: unknown
    const Tab = () => {
      yaml = useResourceYaml({ target: { kind: 'CustomResourceInstance', namespace: null, name: 'default', rawJson }, tab: 'yaml', canEditYaml: true }).yamlData
      return null
    }
    renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Tab)))
    return yaml
  }

  it('of another CRD with the same name is not the YAML read of the one before', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    expect(shown(client, NODEPOOL)).toBeUndefined()
    const [nodePool] = client.getQueryCache().findAll({ queryKey: ['resource-yaml'] })
    client.setQueryData(nodePool.queryKey, { yaml: 'kind: NodePool' })
    expect(shown(client, NODEPOOL)).toEqual({ yaml: 'kind: NodePool' })

    expect(shown(client, NODECLASS)).toBeUndefined()
    const reads = client.getQueryCache().findAll({ queryKey: ['resource-yaml'] })
    expect(reads).toHaveLength(2)
    const nodeClass = reads.find((q) => q !== nodePool)!
    await client.fetchQuery({ queryKey: nodeClass.queryKey, queryFn: nodeClass.options.queryFn as () => Promise<unknown> })
    expect(api.getResourceYaml).toHaveBeenLastCalledWith('ec2nodeclasses.karpenter.k8s.aws', 'default', undefined)
    expect(shown(client, NODECLASS)).toEqual({ yaml: 'read as ec2nodeclasses.karpenter.k8s.aws' })
    expect(shown(client, NODEPOOL)).toEqual({ yaml: 'kind: NodePool' })
  })

  it('is saved as the CRD the drawer names now', async () => {
    await save('CustomResourceInstance', null, NODECLASS)(EDITED, OPENED)
    expect(api.applyResourceYaml).toHaveBeenCalledWith('ec2nodeclasses.karpenter.k8s.aws', 'x', EDITED, undefined, SENT)
  })
})

// Refresh read under a new key with no answer yet, so the editor turned not ready, Refresh went off and the focus fell
// to the page. The last YAML of the same object now stays while Refresh reads it again; another object's never does.
describe('the YAML while Refresh reads it again', () => {
  const key = (kind: string, ns: string | null, name: string, type: string, nonce: number) => ['resource-yaml', kind, ns, name, type, nonce]
  const keep = (from: unknown[], to: unknown[]) => keepSameRead(to, [YAML_NONCE_AT])({ yaml: 'before' }, { queryKey: from })

  it('keeps the last YAML of the same object, and only of that object', () => {
    expect(keep(key('ConfigMap', 'ns', 'cm', 'configmaps', 0), key('ConfigMap', 'ns', 'cm', 'configmaps', 1))).toEqual({ yaml: 'before' })
    expect(keep(key('ConfigMap', 'ns', 'cm', 'configmaps', 0), key('ConfigMap', 'ns', 'other', 'configmaps', 1))).toBeUndefined()
    expect(keep(key('ConfigMap', 'ns', 'cm', 'configmaps', 0), key('ConfigMap', 'ns2', 'cm', 'configmaps', 1))).toBeUndefined()
    expect(keep(key('CustomResourceInstance', null, 'default', 'nodepools.karpenter.sh', 0), key('CustomResourceInstance', null, 'default', 'ec2nodeclasses.karpenter.k8s.aws', 1))).toBeUndefined()
  })

  it('is the read the drawer makes', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const Tab = () => {
      useResourceYaml({ target: { kind: 'ConfigMap', namespace: 'ns', name: 'cm' }, tab: 'yaml', canEditYaml: true })
      return null
    }
    renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Tab)))
    const [read] = client.getQueryCache().findAll({ queryKey: ['resource-yaml'] })
    expect(read.queryKey.slice(0, 4)).toEqual(['resource-yaml', 'ConfigMap', 'ns', 'cm'])
    expect(read.queryKey[YAML_NONCE_AT]).toBe(0)
    const placeholder = (read.options as { placeholderData?: unknown }).placeholderData as (prev: unknown, prevQuery?: { queryKey: unknown[] }) => unknown
    const earlier = read.queryKey.map((part, at) => (at === YAML_NONCE_AT ? 7 : part))
    expect(placeholder({ yaml: 'before' }, { queryKey: earlier })).toEqual({ yaml: 'before' })
    expect(placeholder({ yaml: 'before' }, { queryKey: earlier.map((part, at) => (at === 3 ? 'other' : part)) })).toBeUndefined()
  })
})

describe('the YAML of a kind with no drawer of its own', () => {
  it('is saved in the group the caller named, not the one discovery prefers', async () => {
    let handle!: ReturnType<typeof useResourceYaml>['handleApplyYaml']
    const Window = () => {
      handle = useResourceYaml({ target: { kind: 'Gadget', namespace: 'shop', name: 'x', apiVersion: 'b.example.com/v1' }, tab: 'info', canEditYaml: true }).handleApplyYaml
      return null
    }
    renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Window)))
    await handle(EDITED, OPENED)
    expect(api.applyResourceYaml).toHaveBeenCalledWith('gadget.b.example.com', 'x', EDITED, 'shop', SENT)
  })
})
