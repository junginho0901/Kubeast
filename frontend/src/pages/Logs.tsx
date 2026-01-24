import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api } from '@/services/api'
import { FileText, Download, RefreshCw, Sparkles, AlertCircle } from 'lucide-react'

export default function Logs() {
  const { namespace, pod } = useParams<{ namespace: string; pod: string }>()
  const [tailLines, setTailLines] = useState(100)
  const [showAnalysis, setShowAnalysis] = useState(false)

  const { data: logs, isLoading, refetch } = useQuery({
    queryKey: ['logs', namespace, pod, tailLines],
    queryFn: () => api.getPodLogs(namespace!, pod!, undefined, tailLines),
    enabled: !!namespace && !!pod,
  })

  const analysisMutation = useMutation({
    mutationFn: () => api.analyzeLogs({
      logs: logs || '',
      namespace: namespace!,
      pod_name: pod!,
    }),
  })

  const handleAnalyze = () => {
    setShowAnalysis(true)
    analysisMutation.mutate()
  }

  const handleDownload = () => {
    if (!logs) return
    const blob = new Blob([logs], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${pod}-logs.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (isLoading) {
    return <div className="text-slate-400">로딩 중...</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-3">
            <FileText className="w-8 h-8" />
            Pod 로그
          </h1>
          <p className="mt-2 text-slate-400">
            {namespace} / {pod}
          </p>
        </div>
        <div className="flex gap-3">
          <select
            value={tailLines}
            onChange={(e) => setTailLines(Number(e.target.value))}
            className="px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-primary-500"
          >
            <option value={50}>마지막 50줄</option>
            <option value={100}>마지막 100줄</option>
            <option value={500}>마지막 500줄</option>
            <option value={1000}>마지막 1000줄</option>
          </select>
          <button
            onClick={() => refetch()}
            className="btn btn-secondary flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            새로고침
          </button>
          <button
            onClick={handleDownload}
            className="btn btn-secondary flex items-center gap-2"
          >
            <Download className="w-4 h-4" />
            다운로드
          </button>
          <button
            onClick={handleAnalyze}
            className="btn btn-primary flex items-center gap-2"
          >
            <Sparkles className="w-4 h-4" />
            AI 분석
          </button>
        </div>
      </div>

      {/* AI Analysis */}
      {showAnalysis && (
        <div className="card">
          <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-yellow-400" />
            AI 로그 분석
          </h2>
          {analysisMutation.isPending ? (
            <div className="flex items-center gap-3 text-slate-400">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary-500" />
              분석 중...
            </div>
          ) : analysisMutation.data ? (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium text-slate-400 mb-2">요약</h3>
                <p className="text-white">{analysisMutation.data.summary}</p>
              </div>
              
              {analysisMutation.data.errors.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-slate-400 mb-2">감지된 에러</h3>
                  <div className="space-y-2">
                    {analysisMutation.data.errors.map((error, idx) => (
                      <div key={idx} className="flex items-start gap-3 p-3 bg-slate-700 rounded-lg">
                        <AlertCircle className={`w-5 h-5 flex-shrink-0 ${
                          error.severity === 'critical' ? 'text-red-400' :
                          error.severity === 'high' ? 'text-orange-400' :
                          error.severity === 'medium' ? 'text-yellow-400' :
                          'text-blue-400'
                        }`} />
                        <div>
                          <p className="text-white font-medium">{error.pattern}</p>
                          <p className="text-sm text-slate-400">
                            발생 횟수: {error.occurrences}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {analysisMutation.data.root_cause && (
                <div>
                  <h3 className="text-sm font-medium text-slate-400 mb-2">근본 원인</h3>
                  <p className="text-white">{analysisMutation.data.root_cause}</p>
                </div>
              )}

              {analysisMutation.data.recommendations.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-slate-400 mb-2">해결 방안</h3>
                  <ul className="space-y-2">
                    {analysisMutation.data.recommendations.map((rec, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-white">
                        <span className="text-primary-400 font-bold">{idx + 1}.</span>
                        <span>{rec}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}

      {/* Logs */}
      <div className="card">
        <h2 className="text-xl font-bold text-white mb-4">로그</h2>
        <div className="bg-slate-950 rounded-lg p-4 overflow-x-auto">
          <pre className="text-sm text-slate-300 font-mono whitespace-pre-wrap">
            {logs || '로그가 없습니다.'}
          </pre>
        </div>
      </div>
    </div>
  )
}
