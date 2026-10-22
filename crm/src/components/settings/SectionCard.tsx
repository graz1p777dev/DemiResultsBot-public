export function SectionCard({ icon, title, children }: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl overflow-hidden" style={{ backgroundColor: '#ffffff' }}>
      <div
        className="flex items-center gap-2.5 px-5 py-4"
        style={{ borderBottom: '1px solid #ebebee' }}
      >
        <div
          className="flex items-center justify-center w-8 h-8 rounded-xl"
          style={{ backgroundColor: '#0c4d6c' }}
        >
          {icon}
        </div>
        <h2 className="font-semibold text-sm" style={{ color: '#0c2136' }}>{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  )
}
