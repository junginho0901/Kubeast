import { InfoSection, InfoRow } from '../DetailCommon'
import { cudaVersion, driverVersion, gpuCountOf } from '@/pages/gpu/gpuNumbers'

interface NodeGpuInfoProps {
  nodeDescribe: any
  tr: (key: string, fallback: string, opts?: Record<string, any>) => string
}

export default function NodeGpuInfo({ nodeDescribe, tr }: NodeGpuInfoProps) {
  const labels = nodeDescribe?.labels || {}
  const capacity = nodeDescribe?.capacity || {}
  const allocatable = nodeDescribe?.allocatable || {}
  // a GPU is nvidia.com/gpu or a MIG profile nvidia.com/mig-*, as the GPU screens count them
  const count = (resources: Record<string, string>) => {
    const n = gpuCountOf(resources)
    return n === undefined ? undefined : String(n)
  }
  const gpuLabels: [string, string][] = [
    ['GPU Product', labels['nvidia.com/gpu.product']],
    ['GPU Memory', labels['nvidia.com/gpu.memory']],
    ['GPU Count (Capacity)', count(capacity)],
    ['GPU Count (Allocatable)', count(allocatable)],
    ['MIG Strategy', labels['nvidia.com/mig.strategy']],
    ['CUDA Version', cudaVersion(labels)],
    ['Driver Version', driverVersion(labels)],
    ['GPU Family', labels['nvidia.com/gpu.family']],
    ['GPU Compute Capability', labels['nvidia.com/gpu.compute.major'] ? `${labels['nvidia.com/gpu.compute.major']}.${labels['nvidia.com/gpu.compute.minor'] || '0'}` : undefined],
  ].filter(([, v]) => v != null && v !== '' && v !== undefined) as [string, string][]

  if (gpuLabels.length === 0) return null

  return (
    <InfoSection title={tr('nodes.detail.gpu', 'GPU Info')}>
      <div className="space-y-2">
        {gpuLabels.map(([label, value]) => (
          <InfoRow key={label} label={label} value={value} />
        ))}
      </div>
    </InfoSection>
  )
}
