import { InfoSection, InfoRow } from '../DetailCommon'

interface NodeGpuInfoProps {
  nodeDescribe: any
  tr: (key: string, fallback: string, opts?: Record<string, any>) => string
}

export default function NodeGpuInfo({ nodeDescribe, tr }: NodeGpuInfoProps) {
  const labels = nodeDescribe?.labels || {}
  const capacity = nodeDescribe?.capacity || {}
  const allocatable = nodeDescribe?.allocatable || {}
  const gpuLabels: [string, string][] = [
    ['GPU Product', labels['nvidia.com/gpu.product']],
    ['GPU Memory', labels['nvidia.com/gpu.memory']],
    ['GPU Count (Capacity)', capacity['nvidia.com/gpu']],
    ['GPU Count (Allocatable)', allocatable['nvidia.com/gpu']],
    ['MIG Strategy', labels['nvidia.com/mig.strategy']],
    ['CUDA Version', labels['nvidia.com/cuda.driver.major'] ? `${labels['nvidia.com/cuda.driver.major']}.${labels['nvidia.com/cuda.driver.minor'] || '0'}` : undefined],
    ['Driver Version', labels['nvidia.com/cuda.runtime.major'] ? `${labels['nvidia.com/cuda.runtime.major']}.${labels['nvidia.com/cuda.runtime.minor'] || '0'}` : undefined],
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
