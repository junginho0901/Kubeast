import { Th } from './DetailCommon'
import { deviceRequestRows } from './draText'

// A ResourceClaim's (or a template's claim spec's) device requests: v1 exactly, or each firstAvailable subrequest.
export function DeviceRequestsTable({ requests }: { requests: unknown }) {
  const rows = deviceRequestRows(requests)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs table-fixed min-w-[500px]">
        <thead className="text-slate-400">
          <tr>
            <Th className="text-left py-1 w-[20%]">Name</Th>
            <Th className="text-left py-1 w-[20%]">Device Class</Th>
            <Th className="text-left py-1 w-[30%]">Selectors</Th>
            <Th className="text-left py-1 w-[10%]">Count</Th>
            <Th className="text-left py-1 w-[20%]">Allocation Mode</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {rows.map((r, idx) => (
            <tr key={idx} className="text-slate-200">
              <td className="py-1 pr-2 wrap-break-word">{r.name}</td>
              <td className="py-1 pr-2 wrap-break-word">{r.deviceClass}</td>
              <td className="py-1 pr-2 wrap-break-word font-mono text-[11px]">{r.selectors.length > 0 ? r.selectors.join('; ') : '-'}</td>
              <td className="py-1 pr-2">{r.count}</td>
              <td className="py-1 pr-2 wrap-break-word">{r.allocationMode}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
