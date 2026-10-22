import { ReactNode } from 'react'

export default function BotPlaceholder({ icon, title, subtitle, note }: {
  icon: ReactNode
  title: string
  subtitle: string
  note?: string
}) {
  return (
    <div className="p-8">
      <div
        className="rounded-2xl px-8 py-14 flex flex-col items-center justify-center text-center"
        style={{ backgroundColor: '#ffffff' }}
      >
        <div
          className="flex items-center justify-center rounded-2xl mb-5"
          style={{ width: 56, height: 56, backgroundColor: '#0c4d6c' }}
        >
          {icon}
        </div>
        <h1 className="text-xl font-bold" style={{ color: '#0c2136' }}>{title}</h1>
        <p className="text-sm mt-1.5 max-w-md" style={{ color: '#8a97a5' }}>{subtitle}</p>
        {note && (
          <p className="text-xs mt-5 px-4 py-2 rounded-lg"
             style={{ backgroundColor: '#eef5f9', color: '#0c4d6c' }}>
            {note}
          </p>
        )}
      </div>
    </div>
  )
}
