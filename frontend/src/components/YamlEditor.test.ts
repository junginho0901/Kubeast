import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import YamlEditor from './YamlEditor'

// Only a write that happened is called applied. The server renderer keeps no state, so the editor is held in edit mode
// and what its Apply sets is recorded, by the order of its useState calls.

const SLOT = { draft: 0, editing: 1, applying: 2, error: 3, success: 4 }
const state = vi.hoisted(() => ({ next: 0, sets: {} as Record<number, unknown[]> }))
vi.mock('react', async (original) => {
  const real = await original<typeof import('react')>()
  return {
    ...real,
    useState: (initial: unknown) => {
      const slot = state.next++
      return [slot === 1 ? true : initial, (value: unknown) => { (state.sets[slot] ??= []).push(value) }]
    },
  }
})
vi.mock('@/components/monaco/CodeEditor', () => ({ default: () => null }))

const LABELS = { title: 't', refresh: 'r', copy: 'c', edit: 'e', apply: 'APPLY', applying: 'a', cancel: 'x', loading: 'l', error: 'err', readonly: 'ro', editHint: 'h', applied: 'd', refreshing: 'f' }

type Node = ReactElement<{ children?: unknown; onClick?: () => Promise<void> }>
const findApply = (node: unknown): Node | null => {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findApply(item)
      if (found) return found
    }
    return null
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return null
  const element = node as Node
  return element.type === 'button' && element.props.children === LABELS.apply ? element : findApply(element.props.children)
}

// Renders the editor in edit mode and presses Apply.
const pressApply = async (onApply: (next: string) => Promise<boolean>) => {
  const onApplySuccess = vi.fn()
  const onApplyError = vi.fn()
  let apply: Node | null = null
  const Grab = () => {
    apply = findApply(YamlEditor({ value: 'a: 1\n', canEdit: true, isLoading: false, onApply, onApplySuccess, onApplyError, labels: LABELS }))
    return null
  }
  renderToStaticMarkup(createElement(Grab))
  expect(apply).not.toBeNull()
  await apply!.props.onClick!()
  return { onApplySuccess, onApplyError }
}

describe('YamlEditor Apply', () => {
  beforeEach(() => {
    state.next = 0
    state.sets = {}
  })

  it('calls nothing applied when the write did not happen, and stays in the edit', async () => {
    const { onApplySuccess, onApplyError } = await pressApply(async () => false)
    expect(onApplySuccess).toHaveBeenCalledTimes(0)
    expect(onApplyError).toHaveBeenCalledTimes(0)
    expect(state.sets[SLOT.editing]).toBeUndefined()
    expect(state.sets[SLOT.success]).toBeUndefined()
    expect(state.sets[SLOT.error]).toEqual([null])
    expect(state.sets[SLOT.applying]).toEqual([true, false])
  })

  it('calls a write that happened applied and leaves the edit', async () => {
    const { onApplySuccess, onApplyError } = await pressApply(async () => true)
    expect(onApplySuccess).toHaveBeenCalledTimes(1)
    expect(onApplyError).toHaveBeenCalledTimes(0)
    expect(state.sets[SLOT.editing]).toEqual([false])
    expect(state.sets[SLOT.success]).toEqual([true])
    expect(state.sets[SLOT.applying]).toEqual([true, false])
  })

  it('says why a write failed and stays in the edit', async () => {
    const { onApplySuccess, onApplyError } = await pressApply(async () => {
      throw Object.assign(new Error('x'), { response: { data: { detail: 'managed by Argo CD application e2e-app; change it in Git' } } })
    })
    expect(onApplySuccess).toHaveBeenCalledTimes(0)
    expect(onApplyError).toHaveBeenCalledWith('managed by Argo CD application e2e-app; change it in Git')
    expect(state.sets[SLOT.editing]).toBeUndefined()
    expect(state.sets[SLOT.success]).toBeUndefined()
    expect(state.sets[SLOT.applying]).toEqual([true, false])
  })
})
