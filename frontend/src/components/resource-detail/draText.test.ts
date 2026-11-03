import { describe, expect, it } from 'vitest'
import { configParameterMap, deviceRequestRows, draValueMap } from './draText'

// The request table reads resource.k8s.io/v1: requests[].exactly, or each firstAvailable subrequest named
// "<request>/<subrequest>" as an allocation result names it.
describe('DRA request rows', () => {
  it('exactly and firstAvailable', () => {
    const rows = deviceRequestRows([
      { name: 'gpu', exactly: { deviceClassName: 'gpu.example.com', allocationMode: 'ExactCount', count: 2, selectors: [{ cel: { expression: "device.attributes['gpu.example.com'].index < 4" } }] } },
      { name: 'all', exactly: { deviceClassName: 'gpu.example.com', allocationMode: 'All' } },
      { name: 'pick', firstAvailable: [
        { name: 'big', deviceClassName: 'big.example.com', allocationMode: 'ExactCount', count: 1 },
        { name: 'small', deviceClassName: 'gpu.example.com', allocationMode: 'ExactCount', count: 2 },
      ] },
    ])
    expect(rows).toEqual([
      { name: 'gpu', deviceClass: 'gpu.example.com', selectors: ["device.attributes['gpu.example.com'].index < 4"], count: '2', allocationMode: 'ExactCount' },
      { name: 'all', deviceClass: 'gpu.example.com', selectors: [], count: '-', allocationMode: 'All' },
      { name: 'pick/big', deviceClass: 'big.example.com', selectors: [], count: '1', allocationMode: 'ExactCount' },
      { name: 'pick/small', deviceClass: 'gpu.example.com', selectors: [], count: '2', allocationMode: 'ExactCount' },
    ])
    // v1beta1 (1.32–1.33) writes the request's fields on the request itself
    expect(deviceRequestRows([{ name: 'gpu', deviceClassName: 'gpu.example.com', allocationMode: 'ExactCount', count: 1 }]))
      .toEqual([{ name: 'gpu', deviceClass: 'gpu.example.com', selectors: [], count: '1', allocationMode: 'ExactCount' }])
  })

  it('typed values and config parameters', () => {
    expect(draValueMap({ index: { int: 0 }, model: { string: 'LATEST-GPU-MODEL' }, driverVersion: { version: '1.0.0' } }))
      .toEqual({ index: '0', model: 'LATEST-GPU-MODEL', driverVersion: '1.0.0' })
    expect(draValueMap({ memory: { value: '80Gi' } })).toEqual({ memory: '80Gi' })
    expect(configParameterMap({ apiVersion: 'gpu.resource.example.com/v1alpha1', sharing: { strategy: 'TimeSlicing' } }))
      .toEqual({ apiVersion: 'gpu.resource.example.com/v1alpha1', sharing: '{"strategy":"TimeSlicing"}' })
  })
})
