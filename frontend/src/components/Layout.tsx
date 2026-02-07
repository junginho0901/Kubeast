import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  LayoutDashboard,
  Boxes,
  MessageSquare,
  Activity,
  Layers,
  Users,
  X
} from 'lucide-react'
import { api } from '@/services/api'
import { getStoredMemberId, setStoredMemberId } from '@/services/member'
import { ModalOverlay } from '@/components/ModalOverlay'

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
  const [isMemberModalOpen, setIsMemberModalOpen] = useState(false)
  const [memberId, setMemberId] = useState(() => getStoredMemberId())
  const [newMemberName, setNewMemberName] = useState('')
  const [newMemberRole, setNewMemberRole] = useState<'admin' | 'user'>('user')

  const resetMemberScopedQueries = () => {
    queryClient.removeQueries({ queryKey: ['sessions'] })
    queryClient.removeQueries({ queryKey: ['session'] })
    queryClient.removeQueries({ queryKey: ['ai-config'] })
  }

  const switchMember = (nextMemberId: string) => {
    setStoredMemberId(nextMemberId)
    setMemberId(nextMemberId)
    setIsMemberModalOpen(false)
    resetMemberScopedQueries()
    navigate('/')
  }

  const { data: members } = useQuery({
    queryKey: ['members'],
    queryFn: () => api.getMembers(),
    staleTime: 30000,
  })

  const currentMember = members?.find((m) => m.id === memberId) ?? members?.find((m) => m.id === 'default')

  useEffect(() => {
    if (!members) return
    if (!currentMember && memberId !== 'default') {
      switchMember('default')
    }
  }, [members, memberId, currentMember])

  const createMemberMutation = useMutation({
    mutationFn: ({ name, role }: { name: string; role: 'admin' | 'user' }) => api.createMember(name, role),
    onSuccess: (created) => {
      setNewMemberName('')
      setNewMemberRole('user')
      switchMember(created.id)
      queryClient.invalidateQueries({ queryKey: ['members'] })
    },
  })

  useEffect(() => {
    const checkClusterStatus = async () => {
      try {
        const health = await api.getHealth()
        setClusterStatus(health.kubernetes === 'connected' ? 'connected' : 'disconnected')
      } catch (error) {
        setClusterStatus('disconnected')
      }
    }

    // 초기 체크
    checkClusterStatus()

    // 5초마다 상태 체크
    const interval = setInterval(checkClusterStatus, 5000)

    return () => clearInterval(interval)
  }, [])

  return (
    <div className="min-h-screen bg-slate-900">
      {/* Sidebar */}
      <div className="fixed inset-y-0 left-0 w-64 bg-slate-800 border-r border-slate-700">
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="flex items-center gap-3 px-6 border-b border-slate-700 h-[100px]">
            <Activity className="w-8 h-8 text-primary-500" />
            <div>
              <h1 className="text-xl font-bold text-white">K8s DevOps</h1>
              <p className="text-xs text-slate-400">Assistant</p>
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex-1 px-4 py-6 space-y-2">
            {navigation.map((item) => {
              const isActive = location.pathname === item.href
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className={`
                    flex items-center gap-3 px-4 py-3 rounded-lg transition-colors
                    ${isActive 
                      ? 'bg-primary-600 text-white' 
                      : 'text-slate-300 hover:bg-slate-700 hover:text-white'
                    }
                  `}
                >
                  <item.icon className="w-5 h-5" />
                  <span className="font-medium">{item.name}</span>
                </Link>
              )
            })}
          </nav>

          {/* Footer */}
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

            <button
              type="button"
              onClick={() => setIsMemberModalOpen(true)}
              className="mt-3 w-full flex items-center justify-between gap-3 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-left hover:bg-slate-700/40"
            >
              <div className="min-w-0">
                <div className="text-[11px] text-slate-400">멤버</div>
                <div className="truncate text-sm text-white">{currentMember?.name ?? memberId}</div>
              </div>
              <div className="shrink-0 text-xs text-slate-300">{(currentMember?.role ?? '').toUpperCase()}</div>
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="pl-64">
        <main className={`min-h-screen ${location.pathname === '/ai-chat' ? '' : 'p-8'}`}>
          <Outlet />
        </main>
      </div>

      {isMemberModalOpen && (
        <ModalOverlay onClose={() => setIsMemberModalOpen(false)}>
          <div
            className="w-full max-w-xl rounded-2xl border border-slate-700 bg-slate-800 p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="h-5 w-5 text-primary-400" />
                <h2 className="text-lg font-semibold text-white">Members</h2>
              </div>
              <button
                type="button"
                onClick={() => setIsMemberModalOpen(false)}
                className="rounded-lg p-2 text-slate-300 hover:bg-slate-700/50 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4">
              <div className="text-xs text-slate-400">현재</div>
              <div className="mt-1 flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm text-white">{currentMember?.name ?? memberId}</div>
                  <div className="truncate text-xs text-slate-400">{memberId}</div>
                </div>
                <div className="text-xs text-slate-300">{(currentMember?.role ?? '').toUpperCase()}</div>
              </div>
            </div>

            <div className="mt-5">
              <div className="text-xs text-slate-400">목록</div>
              <div className="mt-2 max-h-56 space-y-2 overflow-auto pr-1">
                {(members ?? []).map((m) => {
                  const active = m.id === memberId
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => switchMember(m.id)}
                      className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                        active
                          ? 'border-primary-600 bg-primary-600/20'
                          : 'border-slate-700 bg-slate-900/30 hover:bg-slate-700/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm text-white">{m.name}</div>
                          <div className="truncate text-xs text-slate-400">{m.id}</div>
                        </div>
                        <div className="shrink-0 text-xs text-slate-300">{String(m.role).toUpperCase()}</div>
                      </div>
                    </button>
                  )
                })}
                {members && members.length === 0 && (
                  <div className="rounded-lg border border-slate-700 bg-slate-900/30 px-3 py-2 text-sm text-slate-300">
                    멤버가 없습니다.
                  </div>
                )}
              </div>
            </div>

            <div className="mt-6 border-t border-slate-700 pt-5">
              <div className="text-xs text-slate-400">새 멤버 만들기</div>
              <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                <input
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  placeholder="이름"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                />
                <select
                  value={newMemberRole}
                  onChange={(e) => setNewMemberRole(e.target.value as 'admin' | 'user')}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-600 sm:w-40"
                >
                  <option value="user">USER</option>
                  <option value="admin">ADMIN</option>
                </select>
                <button
                  type="button"
                  disabled={!newMemberName.trim() || createMemberMutation.isPending}
                  onClick={() =>
                    createMemberMutation.mutate({ name: newMemberName.trim(), role: newMemberRole })
                  }
                  className="w-full rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60 sm:w-40"
                >
                  {createMemberMutation.isPending ? 'Creating...' : 'Create'}
                </button>
              </div>
              {createMemberMutation.isError && (
                <div className="mt-2 text-sm text-red-400">멤버 생성에 실패했습니다.</div>
              )}
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
