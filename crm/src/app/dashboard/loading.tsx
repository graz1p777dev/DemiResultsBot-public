import GlowOrb from '@/components/common/GlowOrb'

export default function DashboardLoading() {
  return (
    <div className="flex flex-col items-center justify-center gap-4" style={{ minHeight: '60vh' }}>
      <GlowOrb size={72} />
      <p className="text-sm" style={{ color: '#8a97a5' }}>Загрузка...</p>
    </div>
  )
}
