import type { TeamMemberStatus } from '@/types'
import { ATTENDANCE_STATUS_MAP, ROLE_LABELS } from '@/lib/constants'
import { getInitials, formatNumber } from '@/lib/formatters'

interface TeamNowProps {
  members: TeamMemberStatus[]
}

function AttendanceDot({ status }: { status: TeamMemberStatus['attendance_status'] }) {
  const info = status ? ATTENDANCE_STATUS_MAP[status] : null
  const dotClass = info?.dot ?? 'bg-gray-300'
  const title = info?.label ?? 'Нет данных'

  return (
    <div
      className={`rounded-full flex-shrink-0 ${dotClass}`}
      style={{ width: 8, height: 8 }}
      title={title}
    />
  )
}

export default function TeamNow({ members }: TeamNowProps) {
  if (members.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-xl"
        style={{
          minHeight: 80,
          backgroundColor: 'rgba(255,255,255,0.6)',
          border: '1px dashed #e5e7eb',
        }}
      >
        <p style={{ fontSize: 13, color: '#a2b4c0' }}>Нет сотрудников</p>
      </div>
    )
  }

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        backgroundColor: '#ffffff',
        border: '1px solid rgba(0,0,0,0.04)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      }}
    >
      {members.map((member, i) => (
        <div
          key={member.id}
          className="flex items-center gap-3 px-4 py-2.5"
          style={{
            borderBottom: i < members.length - 1 ? '1px solid #f9fafb' : 'none',
          }}
        >
          {/* Аватар */}
          <div
            className="flex items-center justify-center rounded-full flex-shrink-0 text-white font-semibold"
            style={{
              width: 30, height: 30,
              backgroundColor: '#0c4d6c',
              fontSize: 10,
            }}
          >
            {getInitials(member.name)}
          </div>

          {/* Имя и роль */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <AttendanceDot status={member.attendance_status} />
              <span
                className="font-medium truncate"
                style={{ fontSize: 13, color: '#0c2136' }}
              >
                {member.name}
              </span>
            </div>
            <p style={{ fontSize: 11, color: '#9ca3af' }}>
              {ROLE_LABELS[member.role as import('@/types').UserRole] ?? member.role}
            </p>
          </div>

          {/* Показатели дня */}
          <div className="flex-shrink-0 text-right">
            <p
              className="tabular-nums font-semibold"
              style={{ fontSize: 12, color: '#0c2136' }}
            >
              {formatNumber(member.fv_today)} ФВ
            </p>
            <p style={{ fontSize: 11, color: '#16a34a' }}>
              {formatNumber(member.sales_today)} продаж
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}
