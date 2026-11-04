import { InfoSection, InfoRow } from '../DetailCommon'
import { nodeGpuRows } from '@/pages/gpu/gpuNumbers'

interface NodeGpuInfoProps {
  nodeDescribe: any
  tr: (key: string, fallback: string, opts?: Record<string, any>) => string
}

export default function NodeGpuInfo({ nodeDescribe, tr }: NodeGpuInfoProps) {
  // a GPU is a device of NVIDIA's, AMD's or Intel's GPU resources, as the GPU screens count them; each company's
  // model, memory, driver and family from its own labels
  const gpuLabels = nodeGpuRows(nodeDescribe?.labels || {}, nodeDescribe?.capacity || {}, nodeDescribe?.allocatable || {})

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
