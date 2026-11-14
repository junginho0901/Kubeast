/* eslint-disable react-hooks/rules-of-hooks -- the hook runs as a plain function here: react's state, refs and effects and the mutation are stood in below */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import drawerSource from '../ResourceDetailDrawer.tsx?raw'
import { useResourceDelete } from './useResourceDelete'

// A delete pressed in the drawer answers a moment later. When back, forward or a link moved the drawer to another object
// meanwhile, the answer is about the object the delete was pressed for: that one is named as deleted and read again, and
// the drawer of the other object stays open with nothing of that delete in it.

// The hook's state between calls, as React keeps it between renders; effects run after each call, as after a commit.
const slots: unknown[] = []
let cursor = 0
let effects: (() => void)[] = []
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (init: unknown) => {
    const at = cursor++
    if (!(at in slots)) slots[at] = init
    return [slots[at], (next: unknown) => { slots[at] = typeof next === 'function' ? (next as (p: unknown) => unknown)(slots[at]) : next }]
  },
  useRef: (init: unknown) => {
    const at = cursor++
    if (!(at in slots)) slots[at] = { current: init }
    return slots[at]
  },
  useEffect: (fn: () => void) => { effects.push(fn) },
}))
vi.mock('react-dom', () => ({ flushSync: (fn: () => void) => fn() }))

// TanStack's mutation: the function of the render it was pressed in runs; its callbacks are those of the newest render
// (the observer hands the mutation each render's options), with the variables it was pressed with.
type Options = { mutationFn: (v: unknown) => Promise<unknown>; onSuccess?: (d: unknown, v: unknown) => unknown; onError?: (e: unknown, v: unknown) => unknown }
const mutation = vi.hoisted(() => ({ latest: null as Options | null, pending: false, variables: undefined as unknown }))
const invalidated: unknown[] = []
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: async ({ queryKey }: { queryKey: unknown }) => { invalidated.push(queryKey) } }),
  useMutation: (options: Options) => {
    mutation.latest = options
    return {
      isPending: mutation.pending,
      variables: mutation.variables,
      mutate: (variables: unknown) => {
        mutation.pending = true
        mutation.variables = variables
        options.mutationFn(variables).then(
          async (data) => { mutation.pending = false; await mutation.latest?.onSuccess?.(data, variables) },
          (err) => { mutation.pending = false; mutation.latest?.onError?.(err, variables) },
        )
      },
    }
  },
}))

const answer = vi.hoisted(() => ({ resolve: () => {}, reject: (_e: unknown) => {} }))
const api = vi.hoisted(() => ({
  deleteConfigMap: vi.fn(() => new Promise<void>((resolve, reject) => { answer.resolve = resolve; answer.reject = reject })),
}))
vi.mock('@/services/api', () => ({ api }))
const announced = vi.hoisted(() => [] as unknown[])
vi.mock('@/services/createdNoticeStore', () => ({ announceDeleted: (_path: string, object: unknown) => { announced.push(object) } }))
vi.stubGlobal('window', { location: { pathname: '/configuration/configmaps' } })

const close = vi.fn()
const configMap = (name: string) => ({ kind: 'ConfigMap', namespace: 'shop', name })
const render = (target: ReturnType<typeof configMap> | null) => {
  cursor = 0
  effects = []
  const out = useResourceDelete({ target, close })
  effects.forEach((fn) => fn())
  return out
}
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  slots.length = 0
  invalidated.length = 0
  announced.length = 0
  close.mockClear()
  api.deleteConfigMap.mockClear()
  mutation.pending = false
  mutation.variables = undefined
})

describe('a delete that answers after the drawer moved to another object', () => {
  it('deletes and names the object it was pressed for, and leaves the other object\'s drawer open', async () => {
    render(configMap('a')).deleteObject()
    render(configMap('b'))
    answer.resolve()
    await settle()
    expect(api.deleteConfigMap).toHaveBeenCalledWith('shop', 'a')
    expect(announced).toEqual([{ kind: 'ConfigMap', name: 'a', namespace: 'shop' }])
    expect(close).not.toHaveBeenCalled()
    expect(invalidated).toContainEqual(['configmap-describe', 'shop', 'a'])
    expect(invalidated).not.toContainEqual(['configmap-describe', 'shop', 'b'])
  })

  it('shows the other object\'s Delete window no delete under way, nor the refusal of the first', async () => {
    render(configMap('a')).deleteObject()
    expect(render(configMap('b')).deletePending).toBe(false)
    expect(render(configMap('a')).deletePending).toBe(true)
    render(configMap('b'))
    answer.reject({ response: { data: { detail: 'configmaps "a" is forbidden' } } })
    await settle()
    expect(render(configMap('b')).deleteError).toBeNull()
  })
})

describe('a delete that answers while the drawer still shows its object', () => {
  it('closes the drawer and names the object, as before', async () => {
    render(configMap('a')).deleteObject()
    render(configMap('a'))
    answer.resolve()
    await settle()
    expect(close).toHaveBeenCalledTimes(1)
    expect(announced).toEqual([{ kind: 'ConfigMap', name: 'a', namespace: 'shop' }])
  })

  it('says why it was refused in that object\'s Delete window', async () => {
    render(configMap('a')).deleteObject()
    answer.reject({ response: { data: { detail: 'configmaps "a" is forbidden' } } })
    await settle()
    expect(render(configMap('a')).deleteError).toBe('configmaps "a" is forbidden')
  })

  it('is what the drawer\'s Delete window presses and waits on', () => {
    expect(drawerSource).toContain('onClick={deleteObject}')
    expect(drawerSource).toContain('busy={deletePending}')
    expect(drawerSource).not.toContain('deleteMutation')
  })
})
