import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const PAGE_RESOURCES: Array<[string, string]> = [
  ['/dashboard/consultation-chat', 'consultation_chat'],
  ['/dashboard/bot-analytics', 'bot_analytics'],
  ['/dashboard/bot-reports', 'bot_reports'],
  ['/dashboard/bot-settings', 'bot_settings'],
  ['/dashboard/server-status', 'server_status'],
  ['/dashboard/approvals', 'approvals'],
  ['/dashboard/laboratory', 'laboratory'],
  ['/dashboard/partners', 'partners'],
  ['/dashboard/dialogs', 'inbox'],
  ['/dashboard/clients', 'clients'],
  ['/dashboard/deals', 'deals'],
  ['/dashboard/help', 'help'],
  ['/inventory', 'inventory'],
]

function resourceForPath(pathname: string): string | null {
  return PAGE_RESOURCES.find(([prefix]) => pathname === prefix || pathname.startsWith(prefix + '/'))?.[1] ?? null
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Проверяем токен через GoTrue, а не доверяем данным из cookie.
  const { data: { user } } = await supabase.auth.getUser()

  const pathname      = request.nextUrl.pathname
  // /chat/[leadId] — история чата по ссылке из Telegram-карточки бота
  const isDashboard   = pathname.startsWith('/dashboard') || pathname.startsWith('/chat')
  const isInventory   = pathname.startsWith('/inventory')
  const isCashier     = pathname === '/cashier'
  const isAuthPage    = pathname.startsWith('/auth')

  // Сохраняем обновлённые getUser() cookie и при редиректе. Без этого после
  // автоматического refresh токена браузер получал устаревшую сессию.
  const redirectTo = (path: string) => {
    const url = request.nextUrl.clone()
    url.pathname = path
    const response = NextResponse.redirect(url)
    supabaseResponse.cookies.getAll().forEach(cookie => response.cookies.set(cookie))
    return response
  }

  // Без сессии — только публичные auth-страницы
  if ((isDashboard || isInventory || isCashier) && !user) {
    return redirectTo('/auth/login')
  }

  // Кассир не получает доступ к CRM и товароучёту даже при прямом вводе URL.
  // Роль берём из той же таблицы employees, которую используют RLS и Inventory.
  if (user && (isDashboard || isInventory)) {
    const { data: employee } = await supabase
      .from('employees')
      .select('role')
      .eq('user_id', user.id)
      .is('deleted_at', null)
      .maybeSingle()

    if (employee?.role === 'cashier') {
      return redirectTo('/cashier')
    }

    const resource = resourceForPath(pathname)
    if (resource && employee?.role !== 'owner') {
      const { data: role } = await supabase
        .from('roles')
        .select('id')
        .eq('name', employee?.role ?? '')
        .is('deleted_at', null)
        .maybeSingle()
      const { data: permission } = role
        ? await supabase
          .from('permissions')
          .select('can_view')
          .eq('role_id', role.id)
          .eq('resource', resource)
          .maybeSingle()
        : { data: null }

      // Нет роли, нет строки права или can_view=false — доступ закрыт.
      if (!permission?.can_view) return redirectTo('/dashboard')
    }
  }

  // Эти auth-страницы требуют активную сессию — не редиректим.
  const isSessionRequired = pathname === '/auth/reset-password' || pathname === '/auth/change-password' || pathname === '/auth/mini-password' || pathname === '/auth/account-select'
  if (isAuthPage && !isSessionRequired && user) {
    return redirectTo('/dashboard')
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/chat/:path*',
    '/inventory/:path*',
    '/cashier',
    '/auth/:path*',
  ],
}
