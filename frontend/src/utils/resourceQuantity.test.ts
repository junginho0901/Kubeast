import { describe, expect, it } from 'vitest'
import { bytesToMiB, cpuToMillis, memoryToBytes } from './resourceQuantity'

describe('resource quantities', () => {
  it('reads CPU as millicores', () => {
    expect(cpuToMillis('250m')).toBe(250)
    expect(cpuToMillis('1')).toBe(1000)
    expect(cpuToMillis('0.5')).toBe(500)
    expect(cpuToMillis(undefined)).toBeNull()
    expect(cpuToMillis('abc')).toBeNull()
  })

  it('reads memory as bytes and shows it as MiB', () => {
    expect(memoryToBytes('64Mi')).toBe(64 * 1024 * 1024)
    expect(memoryToBytes('1Gi')).toBe(1024 ** 3)
    expect(memoryToBytes('500M')).toBe(500_000_000)
    expect(memoryToBytes('1048576')).toBe(1048576)
    expect(memoryToBytes('x')).toBeNull()
    expect(bytesToMiB(48 * 1024 * 1024)).toBe(48)
    expect(bytesToMiB(null)).toBeNull()
  })
})
