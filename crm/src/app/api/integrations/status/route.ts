import { NextResponse } from 'next/server'
import { can, getActor } from '@/lib/authz'
import { greenWhatsAppConfig } from '@/lib/green-whatsapp'

export async function GET() {
  const actor = await getActor()
  if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!await can(actor, 'bot_settings', 'view')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || 'https://crm.example.invalid'
  const instagramAccessToken = process.env.INSTAGRAM_ACCESS_TOKEN || process.env.META_PAGE_ACCESS_TOKEN
  return NextResponse.json({
    whatsapp: {
      provider: 'green_api',
      configured: Boolean(greenWhatsAppConfig() && process.env.GREEN_API_WEBHOOK_TOKEN),
      webhook: `${origin}/api/integrations/green-api/webhook/{token}`,
      missing: [
        !process.env.GREEN_API_URL && 'GREEN_API_URL',
        !process.env.GREEN_API_ID_INSTANCE && 'GREEN_API_ID_INSTANCE',
        !process.env.GREEN_API_TOKEN_INSTANCE && 'GREEN_API_TOKEN_INSTANCE',
        !process.env.GREEN_API_WEBHOOK_TOKEN && 'GREEN_API_WEBHOOK_TOKEN',
      ].filter(Boolean),
    },
    instagram: {
      provider: 'Meta API',
      configured: Boolean(process.env.META_APP_SECRET && process.env.META_WEBHOOK_VERIFY_TOKEN && instagramAccessToken),
      partiallyConfigured: Boolean(process.env.META_WEBHOOK_VERIFY_TOKEN && instagramAccessToken),
      webhook: `${origin}/api/integrations/meta/webhook`,
      missing: [
        !process.env.META_APP_SECRET && 'APP_SECRET',
        !process.env.META_WEBHOOK_VERIFY_TOKEN && 'VERIFY_TOKEN',
        !instagramAccessToken && 'INSTAGRAM_ACCESS_TOKEN',
      ].filter(Boolean),
    },
  })
}
