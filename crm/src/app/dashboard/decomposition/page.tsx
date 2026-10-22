'use client'

import { useState, useEffect } from 'react'
import { CompanyDecomposition } from '@/components/decomposition/CompanyDecomposition'
import { MarketingDecomposition } from '@/components/marketing/decomposition'
import { EmployeeDecomposition } from '@/components/decomposition/EmployeeDecomposition'
import { MpDecomposition } from '@/components/decomposition/MpDecomposition'
import { DecompositionOverview } from '@/components/decomposition/DecompositionOverview'
import { TargetologDecomposition } from '@/components/decomposition/TargetologDecomposition'
import {
  getDecompositionBootstrap,
  type DecompositionAccess,
  type DepartmentOption,
  type EmployeeOption,
} from '@/actions/my-decomposition'

// ─── Двухуровневый хаб «Декомпозиция» ─────────────────────────────────────────
// Уровень 1: отдел (для owner / department_head). Уровень 2: сотрудник отдела.
// lmai/mp (и будущие роли с индивидуальной декомпозицией) минуют выбор —
// сразу видят собственный экран. Всё переключение — клиентское состояние,
// без перезагрузки страницы.

const selectStyle: React.CSSProperties = {
  appearance: 'none',
  background: '#f2f8fb',
  border: '1px solid #9bc4d7',
  color: '#0c2136',
  WebkitTextFillColor: '#0c2136',
  borderRadius: '9px',
  padding: '8px 34px 8px 12px',
  fontSize: '13.5px',
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
  minWidth: '230px',
}

const backBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #2a4661',
  color: '#a2b4c0',
  borderRadius: '8px',
  padding: '6px 12px',
  fontSize: '12.5px',
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
}

function Caret() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ position: 'absolute', right: '11px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
      <path d="M5 9l7 7 7-7" stroke="#587286" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

export default function DecompositionPage() {
  const [access, setAccess]           = useState<DecompositionAccess | null>(null)
  const [departments, setDepartments] = useState<DepartmentOption[]>([])
  const [employees, setEmployees]     = useState<EmployeeOption[]>([])
  const [selectedDeptId, setSelectedDeptId] = useState('')  // '' = общая декомпозиция
  const [selectedEmpId, setSelectedEmpId]   = useState('')
  const [loading, setLoading]         = useState(true)

  useEffect(() => {
    let cancelled = false
    // Один запрос вместо трёх последовательных: Next.js всё равно сериализует
    // Server Action POST'ы от одного клиента, поэтому параллелить их с клиента
    // бесполезно — собираем на сервере (getDecompositionBootstrap).
    getDecompositionBootstrap().then(({ access: a, departments: depts, employees: emps }) => {
      if (cancelled) return
      setAccess(a)
      setDepartments(depts)
      setEmployees(emps)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <div style={{ minHeight: 'calc(100vh - 52px)', background: '#e6ebee', padding: '20px' }}>
        {[110, 300, 240].map((h, i) => (
          <div key={i} className="animate-pulse" style={{ height: h, background: '#dde4e9', borderRadius: '16px', marginBottom: '16px' }} />
        ))}
      </div>
    )
  }

  // Сотрудник с индивидуальной декомпозицией — сразу свой экран, без хаба
  if (access?.hasIndividual) {
    return access.role === 'mp' ? <MpDecomposition />
         : access.role === 'targetolog' ? <TargetologDecomposition />
         : <EmployeeDecomposition />
  }

  // Сотрудники без отдела попадают в псевдо-отдел, чтобы не потеряться
  const hasOrphans = employees.some(e => e.department_id === null)
  const deptEmployees = selectedDeptId === '__none__'
    ? employees.filter(e => e.department_id === null)
    : employees.filter(e => e.department_id === selectedDeptId)

  const selected = employees.find(e => e.id === selectedEmpId) ?? null

  // Полная декомпозиция компании открывается за отделом продаж:
  // весь план компании сейчас фактически принадлежит ему
  const selectedDept = departments.find(d => d.id === selectedDeptId) ?? null
  const isSalesDeptSelected = !!selectedDept && selectedDept.name.toLowerCase().includes('прода')
  const isMarketingDeptSelected = !!selectedDept && selectedDept.name.toLowerCase().includes('маркет')

  const handleDeptChange = (deptId: string) => {
    setSelectedDeptId(deptId)
    setSelectedEmpId('')  // смена отдела сбрасывает выбор сотрудника
  }

  // Навигация «Назад» — быстрый возврат, не заменяющий селекты
  const goOverview = () => { setSelectedDeptId(''); setSelectedEmpId('') }
  const goDept     = () => setSelectedEmpId('')
  const deptLabel  = selectedDept?.name ?? (selectedDeptId === '__none__' ? 'Без отдела' : '')

  return (
    <div style={{ minHeight: 'calc(100vh - 52px)', background: '#e6ebee' }}>

      {/* Панель выбора — только для owner / department_head */}
      {access?.isManager && (
        <div style={{
          background: '#0c1f33', padding: '10px 40px',
          display: 'flex', alignItems: 'center', gap: '18px', flexWrap: 'wrap',
          borderBottom: '1px solid #1c3a52',
        }}>
          {/* Кнопки «Назад»: уровень отдела — на обзор; уровень сотрудника — на обзор или к отделу */}
          {selectedDeptId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button onClick={goOverview} style={backBtnStyle} title="Вернуться к обзору по отделам">
                ← Обзор по отделам
              </button>
              {selectedEmpId && deptLabel && (
                <button onClick={goDept} style={backBtnStyle} title={`Вернуться к отделу «${deptLabel}»`}>
                  ← {deptLabel}
                </button>
              )}
              <span style={{ width: '1px', height: '22px', background: '#2a4661' }} />
            </div>
          )}

          {/* Уровень 1: отдел */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '11.5px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#a2b4c0', fontWeight: 600 }}>Отдел</span>
            <div style={{ position: 'relative' }}>
              <select value={selectedDeptId} onChange={e => handleDeptChange(e.target.value)} style={selectStyle}>
                <option value="">Обзор по отделам</option>
                {departments.map(d => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
                {hasOrphans && <option value="__none__">Без отдела</option>}
              </select>
              <Caret />
            </div>
          </div>

          {/* Уровень 2: сотрудник выбранного отдела */}
          {selectedDeptId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '11.5px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#a2b4c0', fontWeight: 600 }}>Сотрудник</span>
              <div style={{ position: 'relative' }}>
                <select value={selectedEmpId} onChange={e => setSelectedEmpId(e.target.value)} style={selectStyle}>
                  <option value="">Вся компания</option>
                  {deptEmployees.map(e => (
                    <option key={e.id} value={e.id}>{e.name} — {e.role_label}</option>
                  ))}
                </select>
                <Caret />
              </div>
              {deptEmployees.length === 0 && (
                <span style={{ fontSize: '12px', color: '#a2b4c0' }}>в отделе нет сотрудников</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Контент: сотрудник → отдел → обзор */}
      {selected ? (
        selected.role === 'mp' ? (
          <MpDecomposition targetEmployeeId={selected.id} />
        ) : selected.role === 'targetolog' ? (
          <TargetologDecomposition targetEmployeeId={selected.id} />
        ) : selected.hasIndividual ? (
          <EmployeeDecomposition targetEmployeeId={selected.id} />
        ) : (
          <CenterCard title="Экран для этой роли в разработке">
            Индивидуальная декомпозиция для сотрудника «{selected.name}» ({selected.role_label}) будет построена следующим шагом. Сейчас она доступна для ролей «Менеджер по продажам» и «Менеджер по лидогенерации».
          </CenterCard>
        )
      ) : !selectedDeptId ? (
        // Обзорный дашборд по умолчанию (для не-менеджера — сразу полный вид компании)
        access?.isManager
          ? <DecompositionOverview departments={departments} onSelectDept={handleDeptChange} />
          : <CompanyDecomposition />
      ) : selectedDeptId === '__none__' ? (
        <CenterCard title="Выберите сотрудника">
          Эти сотрудники не прикреплены к отделу — выберите нужного в списке выше.
        </CenterCard>
      ) : isSalesDeptSelected ? (
        <CompanyDecomposition />
      ) : isMarketingDeptSelected ? (
        <MarketingDecomposition />
      ) : (
        <CenterCard title="Декомпозиция отдела в разработке">
          Индивидуальная декомпозиция этого отдела появится следующим шагом.
        </CenterCard>
      )}
    </div>
  )
}

// ─── Центрированная карточка-заглушка ─────────────────────────────────────────

function CenterCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 20px' }}>
      <div style={{
        background: '#fff', border: '1px solid rgba(12,33,54,0.08)', borderRadius: '16px',
        padding: '32px 36px', boxShadow: '0 2px 14px rgba(12,33,54,0.05)',
        textAlign: 'center', maxWidth: '460px', fontFamily: "'Golos Text', system-ui, sans-serif",
      }}>
        <div style={{ fontSize: '15px', fontWeight: 700, color: '#0c2136' }}>{title}</div>
        <p style={{ fontSize: '13px', color: '#6b7d8a', margin: '10px 0 0' }}>{children}</p>
      </div>
    </div>
  )
}
