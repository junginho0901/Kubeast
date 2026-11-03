export type SortKey = null | 'name' | 'gpu_model' | 'gpu_memory' | 'gpu_capacity' | 'gpu_allocatable' | 'status' | 'mig_strategy'
export type SummaryCard = [label: string, value: number | string, boxClass: string, labelClass: string]

// one badge per part of kubectl's STATUS (Ready,SchedulingDisabled), as the Nodes list draws it
export { nodeStatusBadge as getStatusColor } from '@/utils/nodeStatus'
