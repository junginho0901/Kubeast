import { afterEach, describe, expect, it, vi } from 'vitest'
import { client } from '@/services/api/client'
import { accessRequestsApi } from '@/services/api/access_requests'
import { MY_REQUESTS_PER_PAGE, myRequestsQuery } from './myRequestPages'

// My requests pages through every request of the user: the server cuts the page and counts them all
// (X-Kubeast-Total), so a request older than the newest fifty is still reached.
afterEach(() => vi.restoreAllMocks())

const request = (i: number) => ({ id: `r${i}`, cluster_id: 'default', role: 'Write', status: 'rejected' })

describe('My requests', () => {
  it('asks the server for one page of ten', () => {
    expect(MY_REQUESTS_PER_PAGE).toBe(10)
    expect(myRequestsQuery(1)).toEqual({ limit: 10, offset: 0 })
    // the sixth page: requests 51 to 60, past the newest fifty
    expect(myRequestsQuery(6)).toEqual({ limit: 10, offset: 50 })
    expect(myRequestsQuery(0)).toEqual({ limit: 10, offset: 0 })
  })

  it('reads the page it asked for and the count of every request the user made', async () => {
    const get = vi.spyOn(client, 'get').mockResolvedValue({ data: Array.from({ length: 3 }, (_, i) => request(70 + i)), headers: { 'x-kubeast-total': '73' } })
    const page = await accessRequestsApi.listMyAccessRequestsPage({ limit: 10, offset: 70 })
    expect(get).toHaveBeenCalledWith('/auth/access-requests', { params: { limit: 10, offset: 70 } })
    expect(page.total).toBe(73)
    expect(page.items.map((r) => r.id)).toEqual(['r70', 'r71', 'r72'])
  })

  it('an answer without the count is an error, not a count of the rows that came', async () => {
    vi.spyOn(client, 'get').mockResolvedValue({ data: Array.from({ length: 10 }, (_, i) => request(i)), headers: {} })
    await expect(accessRequestsApi.listMyAccessRequestsPage({ limit: 10, offset: 0 })).rejects.toThrow(/X-Kubeast-Total/)
  })
})
