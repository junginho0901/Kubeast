import { formatAge } from '@/utils/time'

export interface PrinterColumn {
  name: string
  type: string
  priority?: number
  description?: string
}

export interface PrinterCell extends PrinterColumn {
  value: unknown
}

// a printer column's value as the API server printed it for kubectl (server-side printing): a date as its age, a
// boolean as Yes/No, a list or object as the server wrote it
export function printerCellText(cell: PrinterCell | undefined, yes: string, no: string): string {
  const v = cell?.value
  if (v === undefined || v === null || v === '') return '-'
  if (cell?.type === 'date' && typeof v === 'string' && !Number.isNaN(Date.parse(v))) return formatAge(v)
  if (typeof v === 'boolean') return v ? yes : no
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}
