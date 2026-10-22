import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import MiniPasswordForm from './MiniPasswordForm'

export default async function MiniPasswordPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: employee } = await supabase
    .from('employees')
    .select('id, role, must_change_password')
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .single()

  if (!employee) redirect('/auth/login')
  if (employee.must_change_password) redirect('/auth/change-password')
  if (employee.role === 'owner') redirect('/dashboard')

  return <MiniPasswordForm />
}
