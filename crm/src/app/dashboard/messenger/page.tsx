import { getMessengerData } from '@/actions/messenger'
import StaffMessenger from '@/components/messenger/StaffMessenger'

export const dynamic = 'force-dynamic'

export default async function MessengerPage() {
  const data = await getMessengerData()
  if (!data.me) return <div className="p-8 text-sm text-slate-400">Нет доступа к мессенджеру</div>
  return <StaffMessenger initialData={{ ...data, me: data.me }} />
}
