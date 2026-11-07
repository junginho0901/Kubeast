import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CASES from './yamlOpened.cases.json'
import { useResourceYaml } from './useResourceYaml'
import { encodeSecretYaml, yamlOpenedOf } from './utils'

const api = vi.hoisted(() => ({
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
