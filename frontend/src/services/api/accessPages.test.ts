import { afterEach, describe, expect, it, vi } from 'vitest'
import { client } from './client'
import { accessRequestsApi, totalHeader } from './access_requests'
import { accessReviewApi } from './access_review'

describe('totalHeader', () => {
  it('reads the count of every match from X-Kubeast-Total', () => {
    expect(totalHeader({ 'x-kubeast-total': '205' })).toBe(205)
    expect(totalHeader({ 'x-kubeast-total': '0' })).toBe(0)
  })

  it('refuses an answer without a count instead of counting the rows that came', () => {
    for (const bad of [undefined, {}, { 'x-kubeast-total': '' }, { 'x-kubeast-total': 'x' }, { 'x-kubeast-total': '-1' }, { 'x-kubeast-total': '1.5' }]) {
      expect(() => totalHeader(bad)).toThrow(/X-Kubeast-Total/)
    }
  })
})

describe('the paged admin lists', () => {
  afterEach(() => vi.restoreAllMocks())

  it('asks the access requests API for one page of a status and search and keeps its total', async () => {
    const get = vi.spyOn(client, 'get').mockResolvedValue({ data: [{ id: 'r1' }], headers: { 'x-kubeast-total': '205' } })
    const page = await accessRequestsApi.adminAccessRequestsPage({ status: 'decided', q: 'alice', limit: 25, offset: 50 })
    expect(page).toEqual({ items: [{ id: 'r1' }], total: 205 })
    expect(get).toHaveBeenCalledWith('/auth/admin/access-requests', { params: { status: 'decided', q: 'alice', limit: 25, offset: 50 } })
  })

  it('leaves an empty search out and reads a count-only answer', async () => {
    const get = vi.spyOn(client, 'get').mockResolvedValue({ data: [], headers: { 'x-kubeast-total': '3' } })
    expect(await accessRequestsApi.adminAccessRequestsPage({ status: 'pending', q: '', limit: 0, offset: 0 })).toEqual({ items: [], total: 3 })
    expect(get.mock.calls[0][1]).toEqual({ params: { status: 'pending', q: undefined, limit: 0, offset: 0 } })
  })

  it('asks for a page of past sign-offs and keeps how many are kept', async () => {
    const get = vi.spyOn(client, 'get').mockResolvedValue({ data: [{ id: 'a' }, { id: 'b' }], headers: { 'x-kubeast-total': '428' } })
    expect(await accessReviewApi.listAccessReviews({ limit: 25, offset: 425 })).toEqual({ items: [{ id: 'a' }, { id: 'b' }], total: 428 })
    expect(get).toHaveBeenCalledWith('/auth/admin/access-review/history', { params: { limit: 25, offset: 425 } })
  })

  it('stops on an answer that is not a list', async () => {
    vi.spyOn(client, 'get').mockResolvedValue({ data: { detail: 'x' }, headers: { 'x-kubeast-total': '1' } })
    await expect(accessReviewApi.listAccessReviews({ limit: 25, offset: 0 })).rejects.toThrow(/history response/)
    await expect(accessRequestsApi.adminAccessRequestsPage({ limit: 25, offset: 0 })).rejects.toThrow(/access requests response/)
  })
})
