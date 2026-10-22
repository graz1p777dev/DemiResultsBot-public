import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

// Wazzup24 webhook — регистрируется через PATCH https://api.wazzup24.com/v3/webhooks
// с webhooksUri вида https://crm.example.invalid/api/whatsapp/webhook?secret=...
// Секрет в query string — единственная проверка, что запрос реально от Wazzup
// (сам Wazzup ничего не подписывает).

interface WazzupMessage {
  messageId: string
  chatId: string
  chatType: string
  type: string
  isEcho?: boolean
  text?: string
  status: string
}

export async function POST(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get('secret')
  if (!secret || secret !== process.env.WAZZUP_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const messages: WazzupMessage[] = body?.messages ?? []

  const rows = messages
    .filter(m => m.chatType === 'whatsapp' && !m.isEcho)
    .map(m => ({
      phone: m.chatId,
      direction: m.status === 'inbound' ? 'in' as const : 'out' as const,
      text: m.type === 'text' ? (m.text ?? '') : `[${m.type}]`,
      wazzup_message_id: m.messageId,
    }))

  if (rows.length > 0) {
    const supabase = createAdminClient()
    const { error } = await supabase.from('whatsapp_messages').insert(rows)
    if (error) {
      // Wazzup ретраит на ошибку — логируем, но не роняем 200, чтобы не зациклиться
      // на одном и том же сообщении при временном сбое БД.
      console.error('whatsapp webhook insert failed', error)
    }
  }

  return NextResponse.json({ ok: true })
}
