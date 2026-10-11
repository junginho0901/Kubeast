// The small label after a screen name that is still in beta: the sidebar item and
// the page title show the same one.
export function BetaTag({ label, size = 'sm' }: { label: string; size?: 'sm' | 'md' }) {
  const box = size === 'md' ? 'text-xs px-2' : 'text-[10px] px-1.5'
  return <span className={`${box} py-0.5 rounded-full bg-sky-500/10 text-sky-400 font-medium`}>{label}</span>
}
