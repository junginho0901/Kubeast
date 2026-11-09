import { afterEach, describe, expect, it, vi } from 'vitest'
import { client } from './client'
import { recordingsApi } from './recordings'
import { hygieneApi } from './hygiene'

describe('the paged record lists', () => {
  afterEach(() => vi.restoreAllMocks())

  it('asks for one page of session recordings and keeps how many match', async () => {
    const get = vi.spyOn(client, 'get').mockResolvedValue({ data: [{ id: 'rec-1' }], headers: { 'x-kubeast-total': '61' } })
    expect(await recordingsApi.listRecordings({ user: 'a_b', kind: 'exec', limit: 12, offset: 24 })).toEqual({ items: [{ id: 'rec-1' }], total: 61 })
    expect(get).toHaveBeenCalledWith('/cluster/recordings', { params: { cluster: '', user: 'a_b', kind: 'exec', limit: '12', offset: '24' } })
  })

  it('stops on a recordings answer without a count or a list', async () => {
    vi.spyOn(client, 'get').mockResolvedValue({ data: [{ id: 'rec-1' }], headers: {} })
    await expect(recordingsApi.listRecordings({ limit: 12, offset: 0 })).rejects.toThrow(/X-Kubeast-Total/)
    vi.spyOn(client, 'get').mockResolvedValue({ data: { detail: 'x' }, headers: { 'x-kubeast-total': '1' } })
    await expect(recordingsApi.listRecordings({ limit: 12, offset: 0 })).rejects.toThrow(/recordings response/)
  })

  it('asks for one page of a cluster\'s past sign-offs and keeps how many it has', async () => {
    const get = vi.spyOn(client, 'get').mockResolvedValue({ data: [{ id: 'h-13' }], headers: { 'x-kubeast-total': '130' } })
    expect(await hygieneApi.listHygieneReviews('self', { limit: 12, offset: 120 })).toEqual({ items: [{ id: 'h-13' }], total: 130 })
    expect(get).toHaveBeenCalledWith('/cluster/hygiene/history', { params: { cluster: 'self', limit: 12, offset: 120 } })
  })

  it('stops on a sign-offs answer without a count or a list', async () => {
    vi.spyOn(client, 'get').mockResolvedValue({ data: [], headers: {} })
    await expect(hygieneApi.listHygieneReviews('self', { limit: 12, offset: 0 })).rejects.toThrow(/X-Kubeast-Total/)
    vi.spyOn(client, 'get').mockResolvedValue({ data: { detail: 'x' }, headers: { 'x-kubeast-total': '1' } })
    await expect(hygieneApi.listHygieneReviews('self', { limit: 12, offset: 0 })).rejects.toThrow(/history response/)
  })
})
