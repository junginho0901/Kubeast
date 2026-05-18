// IngressClasses 페이지의 검색 필터
//
// frontend/src/pages/network/IngressClasses.tsx 의 Search input 추출.
// IngressClass 는 cluster-scoped 라 namespace dropdown 없음 (search 만).

import type { Dispatch, SetStateAction } from 'react'
import { Search } from 'lucide-react'

interface Props {
  searchQuery: string
  setSearchQuery: Dispatch<SetStateAction<string>>
  searchPlaceholder: string
}

export function IngressClassFilters({
  searchQuery,
  setSearchQuery,
  searchPlaceholder,
}: Props) {
  return (
    <div className="relative shrink-0">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
      <input
        type="text"
        placeholder={searchPlaceholder}
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
      />
    </div>
  )
}
