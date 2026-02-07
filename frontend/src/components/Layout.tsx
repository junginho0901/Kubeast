import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { LayoutDashboard, Boxes, MessageSquare, Activity, Layers, LogOut, Shield } from 'lucide-react'
import { api } from '@/services/api'
import { clearAccessToken } from '@/services/auth'

const navigation = [
  { name: '대시보드', href: '/', icon: LayoutDashboard },
  { name: '네임스페이스', href: '/namespaces', icon: Boxes },
  { name: '리소스 모니터링', href: '/monitoring', icon: Activity },
  { name: '클러스터 뷰', href: '/cluster-view', icon: Layers },
  { name: 'AI 챗', href: '/ai-chat', icon: MessageSquare },
]

export default function Layout() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [clusterStatus, setClusterStatus] = useState<'connected' | 'disconnected' | 'checking'>('checking')

  const {
    data: me,
    isError: isMeError,
  } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: false,
    staleTime: 30000,
  })

  useEffect(() => {
    if (!isMeError) return
    clearAccessToken()
    queryClient.clear()
    navigate('/login')
  }, [isMeError, navigate, queryClient])

  useEffect(() => {
    const checkClusterStatus = async () => {
      try {
        const health = await api.getHealth()
        setClusterStatus(health.kubernetes === 'connected' ? 'connected' : 'disconnected')
      } catch (error) {
        setClusterStatus('disconnected')
      }
    }

    checkClusterStatus()
    const interval = setInterval(checkClusterStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleLogout = () => {
    clearAccessToken()
    queryClient.clear()
    navigate('/login')
  }

  const navItems = me?.role === 'admin'
    ? [...navigation, { name: '유저 관리', href: '/admin/users', icon: Shield }]
    : navigation

  return (
    <div className="min-h-screen bg-slate-900">
      <div className="fixed inset-y-0 left-0 w-64 bg-slate-800 border-r border-slate-700">
        <div className="flex flex-col h-full">
          <div className="flex items-center gap-3 px-6 border-b border-slate-700 h-[100px]">
            <Activity className="w-8 h-8 text-primary-500" />
            <div>
              <h1 className="text-xl font-bold text-white">K8s DevOps</h1>
              <p className="text-xs text-slate-400">Assistant</p>
            </div>
          </div>

          <nav className="flex-1 px-4 py-6 space-y-2">
            {navItems.map((item) => {
              const isActive = location.pathname === item.href
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className={`
                    flex items-center gap-3 px-4 py-3 rounded-lg transition-colors
                    ${isActive ? 'bg-primary-600 text-white' : 'text-slate-300 hover:bg-slate-700 hover:text-white'}
                  `}
                >
                  <item.icon className="w-5 h-5" />
                  <span className="font-medium">{item.name}</span>
                </Link>
              )
            })}
          </nav>

          <div className="px-6 py-4 border-t border-slate-700">
            <div className="flex items-center gap-2 text-sm text-slate-400">
              {clusterStatus === 'checking' ? (
                <>
                  <div className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse"></div>
                  <span>연결 확인 중...</span>
                </>
              ) : clusterStatus === 'connected' ? (
                <>
                  <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                  <span>클러스터 연결됨</span>
                </>
              ) : (
                <>
                  <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
                  <span>클러스터 연결 안 됨</span>
                </>
              )}
            </div>

            <div className="mt-3 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2">
              <div className="text-[11px] text-slate-400">계정</div>
              <div className="mt-0.5 truncate text-sm text-white">{me?.name ?? '...'}</div>
              <div className="truncate text-xs text-slate-400">{me?.email ?? ''}</div>
            </div>

            <button
              type="button"
              onClick={handleLogout}
              className="mt-3 w-full flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700/40"
            >
              <LogOut className="w-4 h-4" />
              로그아웃
            </button>
          </div>
        </div>
      </div>

      <div className="pl-64">
        <main className={`min-h-screen ${location.pathname === '/ai-chat' ? '' : 'p-8'}`}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
