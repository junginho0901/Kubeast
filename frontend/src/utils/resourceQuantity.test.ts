import { describe, expect, it } from 'vitest'
import { bytesToMiB, cpuToMillis, memoryToBytes, quantityValue, quotaPercent } from './resourceQuantity'

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

  it('reads every quantity unit as apimachinery does, in base units', () => {
    expect(quantityValue('207m')).toBeCloseTo(0.207)
    expect(quantityValue('1')).toBe(1)
    expect(quantityValue('1.5')).toBe(1.5)
    expect(quantityValue('500n')).toBeCloseTo(5e-7)
    expect(quantityValue('3u')).toBeCloseTo(3e-6)
    expect(quantityValue('1k')).toBe(1000)
    expect(quantityValue('2M')).toBe(2e6)
    expect(quantityValue('1P')).toBe(1e15)
    expect(quantityValue('1E')).toBe(1e18)
    expect(quantityValue('1e3')).toBe(1000)
    expect(quantityValue('12E-1')).toBeCloseTo(1.2)
    expect(quantityValue('64Mi')).toBe(64 * 1024 ** 2)
    expect(quantityValue('1Ei')).toBe(1024 ** 6)
    expect(quantityValue('.5')).toBe(0.5)
    expect(quantityValue(10)).toBe(10)
    expect(quantityValue('1K')).toBeNull()
    expect(quantityValue('1 Gi')).toBeNull()
    expect(quantityValue('abc')).toBeNull()
    expect(quantityValue('')).toBeNull()
    expect(quantityValue(undefined)).toBeNull()
  })

  it('gives a quota its used over hard in percent across units', () => {
    expect(quotaPercent('207m', '1')).toBe(21)
    expect(quotaPercent('1', '2')).toBe(50)
    expect(quotaPercent('640Mi', '1Gi')).toBe(63)
    expect(quotaPercent('3', '10')).toBe(30)
    expect(quotaPercent('0', '0')).toBeNull()
    expect(quotaPercent(undefined, '1')).toBeNull()
  })
})
