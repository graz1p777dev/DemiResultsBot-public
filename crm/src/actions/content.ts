'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActor, can, getScope, isMarketingManager } from '@/lib/authz'

export type ActionResult = { success: true; id?: string } | { success: false; error: string }

export type ContentPostType = 'reels' | 'carousel' | 'post' | 'stories'
const TYPES: ContentPostType[] = ['reels', 'carousel', 'post', 'stories']

// Роли, которые делают контент — только они в списке «Автор» (не все сотрудники).
// mobilograph/smm появятся позже — уже учтены.
const CONTENT_AUTHOR_ROLES = ['targetolog', 'mobilograph', 'smm']

export interface ContentPost {
  id:             string
  date:           string
  type:           ContentPostType
  author_id:      string | null
  author_name:    string | null
  title:          string | null
  went_to_target: boolean
  reach:          number
  views:          number
  engagement:     number
  profile_visits: number
}

export interface ContentTabData {
  posts:          ContentPost[]
  organicAppeals: number                        // обращения с органики (consultations source='organic')
  authors:        { id: string; name: string }[] // активные сотрудники — для дропдауна автора
}

export interface ContentPostInput {
  date:           string
  type:           ContentPostType
  author_id?:     string | null
  title?:         string | null
  went_to_target: boolean
  reach:          number
  views:          number
  engagement:     number
  profile_visits: number
}

// ─── Чтение вкладки «Контент» за период ───────────────────────────────────────
export async function getContentTabData(dateStart: string, dateEnd: string): Promise<ContentTabData | null> {
  const actor = await getActor()
  if (!actor) return null
  if (!await can(actor, 'marketing', 'view')) return null   // fail-closed
  const scope = await getScope(actor, 'marketing')
  if (!scope) return null
  if (!dateStart || !dateEnd || dateEnd < dateStart) return null

  const admin = createAdminClient()
  const [{ data: rows }, { data: emps }, { data: organic }] = await Promise.all([
    admin.from('content_posts')
      .select('id, date, type, author_id, title, went_to_target, reach, views, engagement, profile_visits')
      .is('deleted_at', null).gte('date', dateStart).lte('date', dateEnd)
      .order('date', { ascending: false }),
    admin.from('employees').select('id, name').is('deleted_at', null).neq('status', 'archived')
      .in('role', CONTENT_AUTHOR_ROLES).order('name'),
    admin.from('consultations').select('id')
      .eq('source', 'organic').is('deleted_at', null).gte('date', dateStart).lte('date', dateEnd),
  ])

  const nameById = new Map((emps ?? []).map(e => [e.id as string, e.name as string]))
  const posts: ContentPost[] = (rows ?? []).map(r => ({
    id:             r.id as string,
    date:           r.date as string,
    type:           r.type as ContentPostType,
    author_id:      (r.author_id as string | null) ?? null,
    author_name:    r.author_id ? (nameById.get(r.author_id as string) ?? null) : null,
    title:          (r.title as string | null) ?? null,
    went_to_target: !!r.went_to_target,
    reach:          Number(r.reach ?? 0),
    views:          Number(r.views ?? 0),
    engagement:     Number(r.engagement ?? 0),
    profile_visits: Number(r.profile_visits ?? 0),
  }))

  return {
    posts,
    organicAppeals: (organic ?? []).length,
    authors: (emps ?? []).map(e => ({ id: e.id as string, name: e.name as string })),
  }
}

// ─── Сохранение публикации (create/update) через аудируемую RPC ───────────────
export async function saveContentPost(id: string | null, input: ContentPostInput): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  // company-level контент: только owner/руководитель (не рядовой targetolog со scope=own)
  if (!await isMarketingManager(actor)) return { success: false, error: 'Недостаточно прав' }

  if (!input.date) return { success: false, error: 'Укажите дату публикации' }
  if (!TYPES.includes(input.type)) return { success: false, error: 'Некорректный тип публикации' }
  const nums = [input.reach, input.views, input.engagement, input.profile_visits]
  if (nums.some(v => v < 0)) return { success: false, error: 'Значения не могут быть отрицательными' }

  const admin = createAdminClient()
  const { data, error } = await admin.rpc('save_content_post', {
    p_id:    id,
    p_data:  {
      date: input.date, type: input.type, author_id: input.author_id ?? null, title: input.title ?? null,
      went_to_target: input.went_to_target,
      reach: input.reach, views: input.views, engagement: input.engagement, profile_visits: input.profile_visits,
    },
    p_actor: actor.employeeId,
  })
  if (error) {
    console.error('[saveContentPost]', error.code, '|', error.message)
    const m = error.message || ''
    if (m.includes('not_marketing_manager') || m.includes('actor_inactive')) return { success: false, error: 'Недостаточно прав' }
    if (m.includes('content_post_not_found')) return { success: false, error: 'Публикация не найдена' }
    return { success: false, error: 'Не удалось сохранить публикацию' }
  }
  revalidatePath('/dashboard/decomposition')
  return { success: true, id: data as string }
}

// ─── Удаление публикации (soft) через аудируемую RPC ──────────────────────────
export async function deleteContentPost(id: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Недостаточно прав' }
  if (!await isMarketingManager(actor)) return { success: false, error: 'Недостаточно прав' }

  const admin = createAdminClient()
  const { error } = await admin.rpc('delete_content_post', { p_id: id, p_actor: actor.employeeId })
  if (error) {
    console.error('[deleteContentPost]', error.code, '|', error.message)
    return { success: false, error: 'Не удалось удалить публикацию' }
  }
  revalidatePath('/dashboard/decomposition')
  return { success: true }
}
