export type SortKey = null | 'name' | 'gpu_model' | 'gpu_memory' | 'gpu_capacity' | 'gpu_allocatable' | 'status' | 'mig_strategy'
export type SummaryCard = [label: string, value: number | string, boxClass: string, labelClass: string]

export function getStatusColor(status: string): string {
  const lower = status.toLowerCase()
  if (lower === 'ready') return 'badge-success'
  if (lower.includes('notready') || lower.includes('unknown')) return 'badge-error'
  return 'badge-warning'
}
