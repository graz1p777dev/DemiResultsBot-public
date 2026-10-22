import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AccountSelectClient } from '@/components/auth/AccountSelectClient'

export default async function AccountSelectPage() {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.user) redirect('/auth/login')

  const { data: employee } = await supabase
    .from('employees')
    .select('id, name, role, must_change_password')
    .eq('user_id', session.user.id)
    .is('deleted_at', null)
    .single()

  if (!employee) redirect('/auth/login')
  if (employee.must_change_password) redirect('/auth/change-password')
  if (employee.role === 'owner') redirect('/dashboard')

  return <AccountSelectClient current={{ id: employee.id, name: employee.name || 'Сотрудник', email: session.user.email || '' }} />
}
