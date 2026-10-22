import { getActor } from '@/lib/authz'

// Общая проверка для всех роутов мониторинга (/api/server/*). Сами роуты не
// попадают под middleware (он матчит /dashboard и /auth), поэтому владельца
// проверяем здесь, иначе они были бы открыты по прямой ссылке.
export async function isOwnerRequest(): Promise<boolean> {
  const actor = await getActor()
  return actor?.role === 'owner'
}
