import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { cookies } from 'next/headers'
import './globals.css'
import { AuthProvider } from '@/contexts/AuthContext'
import { getImpersonationState } from '@/actions/auth'
import { createClient } from '@/lib/supabase/server'
import { Toaster } from 'sonner'
import { Employee } from '@/types'
import { DEFAULT_ACCENT, ACCENT_COOKIE_NAME, isAccentId } from '@/lib/accent-theme'
import { getPermissionsForRole } from '@/lib/identity'

const inter = Inter({ subsets: ['latin', 'cyrillic'] })

export const metadata: Metadata = {
  title: 'Demi Results CRM',
  description: 'Система управления бизнесом',
}

// Root layout — читает сессию и employee один раз на SSR.
// Передаёт данные в AuthProvider как начальное состояние:
// клиент стартует с уже известным пользователем, без race condition onAuthStateChange.
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const jar = await cookies()
  const accentCookie = jar.get(ACCENT_COOKIE_NAME)?.value
  const accent = isAccentId(accentCookie) ? accentCookie : DEFAULT_ACCENT

  const supabase = await createClient()

  // Параллельно получаем сессию и состояние impersonation.
  const [{ data: { session } }, initialImpersonation] = await Promise.all([
    supabase.auth.getSession(),
    getImpersonationState(),
  ])

  let initialEmployee: Employee | null = null
  let initialRealUser: Employee | null = null
  let initialVisibleResources: string[] = []

  if (session?.user) {
    const { data: emp } = await supabase
      .from('employees')
      .select('*')
      .eq('user_id', session.user.id)
      .is('deleted_at', null)
      .single()

    if (emp) {
      const employee = emp as Employee

      if (employee.role === 'owner' && initialImpersonation) {
        // Режим impersonation: realUser = owner, user = цель impersonation.
        const { data: targetEmp } = await supabase
          .from('employees')
          .select('*')
          .eq('id', initialImpersonation.id)
          .is('deleted_at', null)
          .single()

        initialRealUser = employee
        initialEmployee = (targetEmp as Employee | null) ?? employee
      } else {
        initialEmployee = employee
      }

      if (initialEmployee) {
        const permissions = await getPermissionsForRole(initialEmployee.role)
        initialVisibleResources = (permissions ?? [])
          .filter(permission => permission.can_view)
          .map(permission => permission.resource)
      }
    }
  }

  return (
    <html lang="ru" className="h-full" data-accent={accent} suppressHydrationWarning>
      <body className={`${inter.className} min-h-full bg-background`}>
        <script dangerouslySetInnerHTML={{ __html: `try{if(localStorage.getItem('demi-theme')==='dark')document.documentElement.classList.add('dark')}catch(e){}` }} />
        <AuthProvider
          initialEmployee={initialEmployee}
          initialRealUser={initialRealUser}
          initialImpersonation={initialImpersonation}
          initialVisibleResources={initialVisibleResources}
        >
          {children}
        </AuthProvider>
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: '#1a1a2e',
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#e5e7eb',
              borderRadius: '12px',
            },
          }}
        />
      </body>
    </html>
  )
}
