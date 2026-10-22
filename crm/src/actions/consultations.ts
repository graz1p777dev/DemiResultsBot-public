'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActor, can, getScope, inScope, canDeleteConsultationHardRule, type Actor } from '@/lib/authz'

// ─── Zod Schema ───────────────────────────────────────────────────────────────

const ConsultationSchema = z.object({
  date: z.string().min(1, 'Дата обязательна'),
  time: z.string().min(1, 'Время обязательно'),
  client_name: z.string().min(1, 'Имя клиента обязательно'),
  phone: z.string().nullable().optional(),
  deal_number: z.string().nullable().optional(),
  format: z.enum(['Онлайн', 'Офлайн']).nullable().optional(),
  manager_id: z.string().uuid().nullable().optional(),
  // 'Перезаписанный' — системный статус, ставит только RPC rebook_consultation.
  // Прямой create/update не может присвоить его руками (см. .refine ниже).
  status: z.enum(['Придёт', 'Не придёт', 'Перезапись', 'Перезаписанный', 'Отменил', 'Не отвечает']).nullable().optional(),
  alb_status: z.enum(['Не записан', 'Записан', 'Пришёл', 'Не пришёл', 'Купил']).nullable().optional(),
  actual_status: z.enum(['Пришла', 'Не пришла']).nullable().optional(),
  status_after_fv: z.enum(['Купила', 'Не купила', 'Предоплата', 'Дожать', 'Отказ']).nullable().optional(),
  amount: z.number().min(0).default(0),
  delivery_cost: z.number().min(0).default(0),
  // true = клиент по записи (НВ), false = зашёл без предварительной записи
  is_nv: z.boolean().default(true),
  is_returning_customer: z.boolean().default(false),
  // Источник обращения (атрибуция канала) — миграция 061
  source: z.enum(['target', 'organic', 'partner', 'referral', 'other']).default('other'),
  partner_id: z.string().uuid().nullable().optional(),
  comment: z.string().nullable().optional(),
  consulting_doctor: z.string().nullable().optional(),
}).refine(
  (data) => data.status_after_fv !== 'Отказ' || (data.comment && data.comment.trim().length > 0),
  { message: 'При статусе «Отказ» комментарий обязателен', path: ['comment'] }
).refine(
  (data) => data.status !== 'Перезаписанный',
  { message: 'Статус «Перезаписанный» устанавливается только автоматически при переносе', path: ['status'] }
).refine(
  // partner_id заполняется ТОЛЬКО у source='partner' (совпадает с DB CHECK 061)
  (data) => data.source === 'partner' || !data.partner_id,
  { message: 'Партнёр указывается только при источнике «Партнёр»', path: ['partner_id'] }
).refine(
  (data) => data.source !== 'partner' || !!data.partner_id,
  { message: 'Выберите партнёра', path: ['partner_id'] }
)

export type ConsultationFormData = z.infer<typeof ConsultationSchema>

// ─── Action result type ────────────────────────────────────────────────────────

export type ActionResult =
  | { success: true }
  | { success: false; error: string }

const SECTION = 'consultations' as const

// ─── Гарантия employee_kpi ───────────────────────────────────────────────────
// recalculate_decomposition падает с NOT NULL violation когда для менеджера нет
// строки в employee_kpi за этот период (SELECT INTO returns NULL for all vars).
// Вставляем нулевую запись-placeholder — COALESCE внутри функции даст 0.

async function ensureEmployeeKpi(admin: ReturnType<typeof createAdminClient>, managerId: string, date: string) {
  const d = new Date(date)
  await admin.from('employee_kpi').upsert(
    {
      employee_id:  managerId,
      period_year:  d.getFullYear(),
      period_month: d.getMonth() + 1,
    },
    { onConflict: 'employee_id,period_year,period_month', ignoreDuplicates: true }
  )
}

// ─── Разрешённый manager_id при создании — по scope актора ────────────────────
// scope='own': игнорируем присланный manager_id, форсируем «на себя» (не доверяем клиенту).
// scope='team': разрешаем только сотрудника своего отдела (или пусто).
// scope='all': разрешаем любого (или пусто).
// Возвращает null при нарушении границы (используется как признак отказа).

async function resolveManagerIdForCreate(
  admin: ReturnType<typeof createAdminClient>,
  actor: Actor,
  scope: 'own' | 'team' | 'all',
  requestedManagerId: string | null,
): Promise<{ ok: true; managerId: string | null } | { ok: false }> {
  if (scope === 'own') return { ok: true, managerId: actor.employeeId }
  if (!requestedManagerId) return { ok: true, managerId: null }
  if (scope === 'all') return { ok: true, managerId: requestedManagerId }

  // team — сотрудник должен быть в отделе актора
  const { data: target } = await admin
    .from('employees')
    .select('department_id')
    .eq('id', requestedManagerId)
    .is('deleted_at', null)
    .maybeSingle()
  if (!target || target.department_id !== actor.departmentId) return { ok: false }
  return { ok: true, managerId: requestedManagerId }
}

// ─── Загрузка владения существующей записи (для edit/delete/rebook по scope) ──

async function loadOwnership(admin: ReturnType<typeof createAdminClient>, id: string) {
  const { data } = await admin
    .from('consultations')
    .select('manager_id, deleted_at, employees:employees!consultations_manager_id_fkey(department_id)')
    .eq('id', id)
    .maybeSingle()
  if (!data) return null
  const managerDept = (data.employees as unknown as { department_id: string | null } | null)?.department_id ?? null
  return {
    managerId: data.manager_id as string | null,
    departmentId: managerDept,
    deletedAt: data.deleted_at as string | null,
  }
}

// ─── createConsultation ────────────────────────────────────────────────────────

export async function createConsultation(data: ConsultationFormData): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await can(actor, SECTION, 'create')) return { success: false, error: 'Недостаточно прав' }

  const parsed = ConsultationSchema.safeParse(data)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }

  const admin = createAdminClient()
  const scope = await getScope(actor, SECTION)
  if (!scope) return { success: false, error: 'Недостаточно прав' }

  const resolved = await resolveManagerIdForCreate(admin, actor, scope, parsed.data.manager_id ?? null)
  if (!resolved.ok) return { success: false, error: 'Нельзя назначить сотрудника вне вашего отдела' }

  const payload = {
    ...parsed.data,
    format: parsed.data.format ?? null,
    manager_id: resolved.managerId,
    status: parsed.data.status ?? null,
    actual_status: parsed.data.actual_status ?? null,
    alb_status: parsed.data.alb_status ?? null,
    status_after_fv: parsed.data.status_after_fv ?? null,
    phone: parsed.data.phone ?? null,
    deal_number: parsed.data.deal_number ?? null,
    comment: parsed.data.comment ?? null,
    consulting_doctor: parsed.data.consulting_doctor ?? null,
    source: parsed.data.source,
    partner_id: parsed.data.source === 'partner' ? (parsed.data.partner_id ?? null) : null,
  }

  if (payload.manager_id) {
    await ensureEmployeeKpi(admin, payload.manager_id, payload.date)
  }

  const { error } = await admin.rpc('create_consultation', {
    p_data: payload,
    p_actor_employee_id: actor.employeeId,
  })

  if (error) {
    console.error('[createConsultation] code:', error.code, '| msg:', error.message)
    return { success: false, error: 'Ошибка создания записи' }
  }

  revalidatePath('/dashboard/consultations')
  return { success: true }
}

// ─── updateConsultation ────────────────────────────────────────────────────────

export async function updateConsultation(id: string, data: ConsultationFormData): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await can(actor, SECTION, 'edit')) return { success: false, error: 'Недостаточно прав' }

  const parsed = ConsultationSchema.safeParse(data)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }

  const admin = createAdminClient()
  const scope = await getScope(actor, SECTION)
  if (!scope) return { success: false, error: 'Недостаточно прав' }

  const owned = await loadOwnership(admin, id)
  if (!owned || owned.deletedAt) return { success: false, error: 'Запись не найдена' }
  if (!inScope(actor, scope, owned.managerId, owned.departmentId)) {
    return { success: false, error: 'Недостаточно прав на эту запись' }
  }

  const payload = {
    ...parsed.data,
    format: parsed.data.format ?? null,
    manager_id: parsed.data.manager_id ?? null,
    status: parsed.data.status ?? null,
    actual_status: parsed.data.actual_status ?? null,
    alb_status: parsed.data.alb_status ?? null,
    status_after_fv: parsed.data.status_after_fv ?? null,
    phone: parsed.data.phone ?? null,
    deal_number: parsed.data.deal_number ?? null,
    comment: parsed.data.comment ?? null,
    consulting_doctor: parsed.data.consulting_doctor ?? null,
    source: parsed.data.source,
    partner_id: parsed.data.source === 'partner' ? (parsed.data.partner_id ?? null) : null,
  }

  if (payload.manager_id) {
    await ensureEmployeeKpi(admin, payload.manager_id, payload.date)
  }

  // scope + department передаём в RPC — финальная проверка охвата (в т.ч. НОВОГО
  // manager_id) выполняется ВНУТРИ транзакции после FOR UPDATE (закрывает TOCTOU).
  const { error } = await admin.rpc('update_consultation', {
    p_id: id,
    p_data: payload,
    p_actor_employee_id: actor.employeeId,
    p_actor_scope: scope,
    p_actor_department_id: actor.departmentId,
  })

  if (error) {
    console.error('[updateConsultation] code:', error.code, '| msg:', error.message)
    if ((error.message || '').includes('scope_violation')) {
      return { success: false, error: 'Нельзя назначить/изменить запись вне вашего охвата' }
    }
    return { success: false, error: 'Ошибка обновления записи' }
  }

  revalidatePath('/dashboard/consultations')
  return { success: true }
}

// ─── rebookConsultation ────────────────────────────────────────────────────────
// Атомарный перенос через транзакционную RPC rebook_consultation (миграция 037/039):
// одной транзакцией — SELECT ... FOR UPDATE старой, проверка что активна и не перенесена,
// INSERT новой ('Перезаписанный' + ссылка ОТКУДА), UPDATE старой ('Перезапись' + ссылка КУДА),
// запись в аудит. «Или всё, или ничего» — нет орфанов и защита от повторного/гонкового переноса.
// Право — 'edit' (перезапись — это операция редактирования существующей записи).

export async function rebookConsultation(
  id: string,
  newDate: string,
  newTime: string,
  currentData: ConsultationFormData,
): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await can(actor, SECTION, 'edit')) return { success: false, error: 'Недостаточно прав' }

  const parsed = ConsultationSchema.safeParse(currentData)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }

  const admin = createAdminClient()
  const scope = await getScope(actor, SECTION)
  if (!scope) return { success: false, error: 'Недостаточно прав' }

  const owned = await loadOwnership(admin, id)
  if (!owned || owned.deletedAt) return { success: false, error: 'Запись не найдена' }
  if (!inScope(actor, scope, owned.managerId, owned.departmentId)) {
    return { success: false, error: 'Недостаточно прав на эту запись' }
  }

  // Плейсхолдер employee_kpi для нового менеджера/периода — иначе триггер recalc внутри RPC
  // упадёт с NOT NULL. Идемпотентно, вне RPC-транзакции (безопасно существовать отдельно).
  if (parsed.data.manager_id) {
    await ensureEmployeeKpi(admin, parsed.data.manager_id, newDate)
  }

  const { error } = await admin.rpc('rebook_consultation', {
    p_old_id:   id,
    p_new_date: newDate,
    p_new_time: newTime,
    p_data:     parsed.data,
    p_actor_employee_id: actor.employeeId,
    p_actor_scope: scope,
    p_actor_department_id: actor.departmentId,
  })

  if (error) {
    console.error('[rebookConsultation] rpc error:', error.code, '|', error.message)
    const msg = error.message || ''
    if (msg.includes('scope_violation')) {
      return { success: false, error: 'Нельзя перенести/назначить запись вне вашего охвата' }
    }
    if (msg.includes('already_rescheduled')) {
      return { success: false, error: 'Эта запись уже перенесена' }
    }
    if (msg.includes('consultation_deleted')) {
      return { success: false, error: 'Запись удалена' }
    }
    if (msg.includes('consultation_not_found')) {
      return { success: false, error: 'Запись не найдена' }
    }
    return { success: false, error: 'Ошибка перезаписи' }
  }

  revalidatePath('/dashboard/consultations')
  return { success: true }
}

// ─── deleteConsultation (soft delete) ─────────────────────────────────────────
// ЖЁСТКОЕ ПРАВИЛО: удаление консультаций разрешено ТОЛЬКО owner — независимо от того,
// что выставлено в permissions.can_delete для роли (canDeleteConsultationHardRule — хардкод,
// не читает таблицу и не настраивается через панель прав).

export async function deleteConsultation(id: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!canDeleteConsultationHardRule(actor)) {
    return { success: false, error: 'Удаление записей доступно только Владельцу' }
  }

  const admin = createAdminClient()
  const { error } = await admin.rpc('delete_consultation', {
    p_id: id,
    p_actor_employee_id: actor.employeeId,
  })

  if (error) {
    console.error('[deleteConsultation] code:', error.code, '| msg:', error.message)
    return { success: false, error: 'Ошибка удаления записи' }
  }

  revalidatePath('/dashboard/consultations')
  return { success: true }
}

// ─── getConsultationAuditLog: история изменений записи (owner/rop) ─────────────

export interface AuditLogEntry {
  id: string
  action: 'create' | 'update' | 'delete' | 'rebook'
  changes: Record<string, { old: unknown; new: unknown }> | Record<string, unknown>
  created_at: string
  changed_by_name: string | null
}

export async function getConsultationAuditLog(consultationId: string): Promise<AuditLogEntry[]> {
  const actor = await getActor()
  if (!actor) return []
  // Доступ к аудиту — owner всегда; остальные — если у них есть 'view' на consultations.
  if (actor.role !== 'owner' && actor.role !== 'rop') return []
  if (!await can(actor, SECTION, 'view')) return []

  const scope = await getScope(actor, SECTION)
  if (!scope) return []

  const admin = createAdminClient()

  // BOLA-гейт + анти-TOCTOU: проверка охвата (по manager_id/отделу консультации) и чтение
  // журнала — в ОДНОМ снимке через RPC get_consultation_audit (057). Раньше rop мог передать
  // чужой consultationId, а проверка владения и чтение шли двумя запросами (окно гонки).
  const { data, error } = await admin.rpc('get_consultation_audit', {
    p_consultation_id:     consultationId,
    p_actor_employee_id:   actor.employeeId,
    p_actor_scope:         scope,
    p_actor_department_id: actor.departmentId,
  })
  if (error) {
    console.error('[getConsultationAuditLog]', error.code, '|', error.message)
    return []
  }

  type AuditRow = { id: string; action: string; changes: unknown; created_at: string; changed_by_name: string | null }
  return ((data ?? []) as AuditRow[]).map(row => ({
    id: row.id,
    action: row.action as AuditLogEntry['action'],
    changes: row.changes as AuditLogEntry['changes'],
    created_at: row.created_at,
    changed_by_name: row.changed_by_name,
  }))
}
