'use client'

import { useEffect, useState } from 'react'
import { botGet, botJson } from '@/lib/bot-api'
import { AlertTriangle, Bot, Cpu, Brain, MessageCircle, ShieldCheck, Trash2, Zap } from 'lucide-react'

type TgManager = { name: string; chat_id: string }
type ChannelStatus = Record<'whatsapp' | 'instagram', {
  provider: string; configured: boolean; partiallyConfigured?: boolean; webhook: string | null; missing: string[]
}>

function SectionCard({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl overflow-hidden bg-white">
      <div className="flex items-center gap-2.5 px-5 py-4" style={{ borderBottom: '1px solid #ebebee' }}>
        <div className="flex items-center justify-center w-8 h-8 rounded-xl" style={{ backgroundColor: '#0c4d6c' }}>
          {icon}
        </div>
        <h2 className="font-semibold text-sm" style={{ color: '#0c2136' }}>{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  )
}

const btnPrimary = 'rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-50'
const areaCls = 'w-full rounded-xl px-3 py-2.5 text-xs outline-none resize-y font-mono leading-relaxed'
const areaStyle = { backgroundColor: '#f5f6f8', color: '#0c2136' } as const

export default function BotSettingsPage() {
  // Промпт
  const [prompt, setPrompt] = useState('')
  const [promptSaved, setPromptSaved] = useState(false)
  // Память магазина
  const [memory, setMemory] = useState('')
  const [memorySaved, setMemorySaved] = useState(false)
  // Модель
  const [models, setModels] = useState<string[]>([])
  const [modelSimple, setModelSimple] = useState('')
  const [modelSales, setModelSales] = useState('')
  const [modelSaved, setModelSaved] = useState(false)
  // Менеджеры
  const [managers, setManagers] = useState<TgManager[]>([])
  const [mgrName, setMgrName] = useState('')
  const [mgrChatId, setMgrChatId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState('')
  const [botMode, setBotMode] = useState('manual')
  const [approvalChannel, setApprovalChannel] = useState('crm')
  const [operationsSaved, setOperationsSaved] = useState(false)
  const [error, setError] = useState('')
  const [channels, setChannels] = useState<ChannelStatus | null>(null)
  const [budget, setBudget] = useState({ monthly_budget_usd: 0, warn_at_percent: 80, spent_usd: 0 })

  useEffect(() => {
    Promise.allSettled([
      botGet<{ prompt: string }>('/admin/bot-prompt'),
      botGet<{ memory: string }>('/admin/bot-memory'),
      botGet<string[]>('/admin/openai-models'),
      botGet<{ model_simple: string; model_sales: string }>('/admin/bot-model'),
      botGet<TgManager[]>('/admin/managers'),
      botGet<{ mode: string }>('/admin/bot-mode'),
      botGet<{ channel: string }>('/admin/approval-settings'),
      fetch('/api/integrations/status', { cache: 'no-store' }).then(response => response.json() as Promise<ChannelStatus>),
      botGet<{ monthly_budget_usd: number; warn_at_percent: number; spent_usd: number }>('/admin/budget-alert'),
    ]).then(([p, mem, mods, mod, mgr, mode, approvals, channelStatus, budgetStatus]) => {
      if (p.status === 'fulfilled') setPrompt(p.value.prompt)
      if (mem.status === 'fulfilled') setMemory(mem.value.memory)
      if (mods.status === 'fulfilled') setModels(mods.value)
      if (mod.status === 'fulfilled') { setModelSimple(mod.value.model_simple); setModelSales(mod.value.model_sales) }
      if (mgr.status === 'fulfilled') setManagers(mgr.value)
      if (mode.status === 'fulfilled') setBotMode(mode.value.mode)
      if (approvals.status === 'fulfilled') setApprovalChannel(approvals.value.channel)
      if (channelStatus.status === 'fulfilled') setChannels(channelStatus.value)
      if (budgetStatus.status === 'fulfilled') setBudget(budgetStatus.value)
      setLoading(false)
    })
  }, [])

  const saveOperations = async () => {
    setSaving('operations')
    setError('')
    try {
      await Promise.all([
        botJson('/admin/bot-mode', 'PATCH', { mode: botMode }),
        botJson('/admin/approval-settings', 'PATCH', { channel: approvalChannel }),
      ])
      setOperationsSaved(true)
      setTimeout(() => setOperationsSaved(false), 2000)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Настройки не сохранены')
    } finally {
      setSaving('')
    }
  }

  const savePrompt = async () => {
    setSaving('prompt')
    setError('')
    try { await botJson('/admin/bot-prompt', 'PATCH', { prompt }); setPromptSaved(true); setTimeout(() => setPromptSaved(false), 2000) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Промпт не сохранён') }
    finally { setSaving('') }
  }
  const saveMemory = async () => {
    setSaving('memory')
    setError('')
    try { await botJson('/admin/bot-memory', 'PATCH', { memory }); setMemorySaved(true); setTimeout(() => setMemorySaved(false), 2000) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Память не сохранена') }
    finally { setSaving('') }
  }
  const saveModel = async () => {
    setSaving('model')
    setError('')
    try { await botJson('/admin/bot-model', 'PATCH', { model_simple: modelSimple, model_sales: modelSales }); setModelSaved(true); setTimeout(() => setModelSaved(false), 2000) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Модели не сохранены') }
    finally { setSaving('') }
  }
  const addManager = async () => {
    if (!mgrName.trim() || !mgrChatId.trim()) return
    try {
      const res = await botJson<{ managers: TgManager[] }>('/admin/managers', 'POST', { name: mgrName.trim(), chat_id: mgrChatId.trim() })
      setManagers(res.managers); setMgrName(''); setMgrChatId('')
    } catch { alert('Не удалось добавить (возможно, chat_id уже есть)') }
  }
  const removeManager = async (m: TgManager) => {
    if (!confirm(`Удалить менеджера ${m.name}?`)) return
    const res = await botJson<{ managers: TgManager[] }>(`/admin/managers/${encodeURIComponent(m.chat_id)}`, 'DELETE')
    setManagers(res.managers)
  }

  if (loading) return <p className="p-8 text-sm" style={{ color: '#8a97a5' }}>Загрузка настроек...</p>

  const selectCls = 'w-full rounded-xl px-3 py-2 text-sm outline-none'

  return (
    <div data-dark-blue-surfaces className="p-4 md:p-8 flex flex-col gap-5 max-w-4xl">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: '#678091' }}>AI operations</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight" style={{ color: '#0c2136' }}>Настройки бота</h1>
        <p className="mt-1 text-sm" style={{ color: '#78909f' }}>Управляйте поведением AI и маршрутом согласования ответов.</p>
      </div>

      {error && <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"><AlertTriangle size={16} className="mt-0.5 shrink-0" />{error}</div>}

      {channels && (
        <SectionCard icon={<MessageCircle size={15} color="#fff" />} title="Каналы CRM">
          <div className="grid gap-3 md:grid-cols-2">
            {Object.entries(channels).map(([channel, item]) => (
              <div key={channel} className="rounded-xl border border-[#e0e7eb] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div><p className="text-sm font-semibold capitalize" style={{ color: '#0c2136' }}>{channel}</p><p className="text-xs" style={{ color: '#78909f' }}>{item.provider}</p></div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${item.configured ? 'bg-emerald-50 text-emerald-700' : item.partiallyConfigured ? 'bg-sky-50 text-sky-700' : 'bg-amber-50 text-amber-700'}`}>
                    {item.configured ? 'Подключён' : item.partiallyConfigured ? 'Частично настроен' : 'Ждёт ключи'}
                  </span>
                </div>
                {item.webhook && <p className="mt-3 break-all rounded-lg bg-[#f5f8fa] p-2 font-mono text-[11px]" style={{ color: '#526b78' }}>Webhook: {item.webhook}</p>}
                {!item.configured && <p className="mt-2 text-xs" style={{ color: '#8a97a5' }}>Нужно добавить: {item.missing.join(', ')}</p>}
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs leading-5" style={{ color: '#78909f' }}>Приём текста, фото и файлов уже подготовлен. Секреты хранятся только на сервере; после получения API-ключей подключение активируется без изменения интерфейса CRM.</p>
        </SectionCard>
      )}

      <SectionCard icon={<AlertTriangle size={15} color="#fff" />} title="Контроль AI-бюджета">
        <p className="mb-3 text-xs leading-5" style={{ color: '#78909f' }}>Бот проверяет расход дважды в день. При достижении порога Telegram сообщит о низком остатке и попросит позвонить владельцу, чтобы напомнить о пополнении.</p>
        <div className="grid max-w-lg gap-3 sm:grid-cols-3">
          <label className="text-xs font-semibold text-[#78909f]">Бюджет в месяц, $<input type="number" min="0" step="1" value={budget.monthly_budget_usd} onChange={event => setBudget(value => ({ ...value, monthly_budget_usd: Number(event.target.value) }))} className="mt-1 h-10 w-full rounded-xl bg-[#f5f6f8] px-3 text-sm text-[#0c2136] outline-none" /></label>
          <label className="text-xs font-semibold text-[#78909f]">Предупредить при, %<input type="number" min="1" max="100" value={budget.warn_at_percent} onChange={event => setBudget(value => ({ ...value, warn_at_percent: Number(event.target.value) }))} className="mt-1 h-10 w-full rounded-xl bg-[#f5f6f8] px-3 text-sm text-[#0c2136] outline-none" /></label>
          <div className="rounded-xl bg-[#f5f6f8] p-3"><p className="text-[10px] font-semibold uppercase text-[#8a97a5]">Потрачено</p><p className="mt-1 text-lg font-bold text-[#0c4d6c]">${budget.spent_usd.toFixed(2)}</p></div>
        </div>
        <button onClick={async () => { setSaving('budget'); try { const result = await botJson<typeof budget>('/admin/budget-alert', 'PATCH', budget); setBudget(result) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Бюджет не сохранён') } finally { setSaving('') } }} disabled={saving === 'budget'} className={`${btnPrimary} mt-3`} style={{ backgroundColor: '#0c4d6c' }}>{saving === 'budget' ? 'Сохранение...' : 'Сохранить контроль бюджета'}</button>
      </SectionCard>

      <SectionCard icon={<ShieldCheck size={15} color="#fff" />} title="Режим работы и согласование">
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <label className="block text-xs font-semibold mb-2 uppercase" style={{ color: '#8a97a5' }}>Как AI обучается</label>
            <div className="space-y-2">
              {[
                ['manual', 'Контроль', 'AI готовит ответ, менеджер принимает или исправляет.'],
                ['aggressive', 'Контроль + обучение', 'После отклонения AI дополняет промпт причиной менеджера.'],
                ['autonomous', 'Автономный — пока закрыт', 'Значение сохраняется, но отправка без менеджера намеренно не включена.'],
              ].map(([value, title, description]) => (
                <label key={value} className={`block rounded-xl border p-3 cursor-pointer ${botMode === value ? 'border-[#73a6bd] bg-[#eef7fa]' : 'border-[#e0e7eb]'}`}>
                  <span className="flex items-start gap-2">
                    <input type="radio" name="bot-mode" value={value} checked={botMode === value} onChange={() => setBotMode(value)} className="mt-1" />
                    <span><span className="block text-sm font-semibold" style={{ color: '#0c2136' }}>{title}</span><span className="mt-0.5 block text-xs leading-5" style={{ color: '#6f8491' }}>{description}</span></span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold mb-2 uppercase" style={{ color: '#8a97a5' }}>Где принимать ответы</label>
            <div className="space-y-2">
              {[
                ['crm', 'Только CRM', 'Основной режим: карточки появляются в разделе «Согласования».'],
                ['both', 'CRM + Telegram', 'CRM остаётся основной, Telegram получает резервную копию.'],
                ['telegram', 'Только Telegram', 'Старый режим для временного отката.'],
              ].map(([value, title, description]) => (
                <label key={value} className={`block rounded-xl border p-3 cursor-pointer ${approvalChannel === value ? 'border-[#73a6bd] bg-[#eef7fa]' : 'border-[#e0e7eb]'}`}>
                  <span className="flex items-start gap-2">
                    <input type="radio" name="approval-channel" value={value} checked={approvalChannel === value} onChange={() => setApprovalChannel(value)} className="mt-1" />
                    <span><span className="block text-sm font-semibold" style={{ color: '#0c2136' }}>{title}</span><span className="mt-0.5 block text-xs leading-5" style={{ color: '#6f8491' }}>{description}</span></span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <button onClick={saveOperations} disabled={saving === 'operations'} className={`${btnPrimary} mt-4 flex items-center gap-2`} style={{ backgroundColor: '#237354' }}>
          <Zap size={14} /> {saving === 'operations' ? 'Сохранение...' : operationsSaved ? '✓ Сохранено' : 'Сохранить режим'}
        </button>
      </SectionCard>

      <SectionCard icon={<Bot size={15} color="#fff" />} title="Промпт бота">
        <p className="text-xs mb-3" style={{ color: '#8a97a5' }}>
          Системный промпт, которым руководствуется Айым при ответах клиентам. Применяется сразу после сохранения.
        </p>
        <textarea rows={16} value={prompt} onChange={e => setPrompt(e.target.value)} className={areaCls} style={areaStyle} />
        <div className="mt-3">
          <button onClick={savePrompt} disabled={saving === 'prompt'} className={btnPrimary} style={{ backgroundColor: '#0c4d6c' }}>
            {saving === 'prompt' ? 'Сохранение...' : promptSaved ? '✓ Сохранено' : 'Сохранить промпт'}
          </button>
        </div>
      </SectionCard>

      <SectionCard icon={<Cpu size={15} color="#fff" />} title="Модель бота">
        <p className="text-xs mb-3" style={{ color: '#8a97a5' }}>
          «Простые вопросы» — обычные сообщения, «Продажи» — возражения и сложные диалоги.
        </p>
        <div className="grid gap-3 sm:grid-cols-2" style={{ maxWidth: 480 }}>
          <div>
            <label className="block text-xs font-semibold mb-1.5 uppercase" style={{ color: '#8a97a5' }}>Простые вопросы</label>
            <select value={modelSimple} onChange={e => setModelSimple(e.target.value)} className={selectCls} style={areaStyle}>
              {modelSimple && !models.includes(modelSimple) && <option value={modelSimple}>{modelSimple}</option>}
              {models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5 uppercase" style={{ color: '#8a97a5' }}>Продажи / возражения</label>
            <select value={modelSales} onChange={e => setModelSales(e.target.value)} className={selectCls} style={areaStyle}>
              {modelSales && !models.includes(modelSales) && <option value={modelSales}>{modelSales}</option>}
              {models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>
        <div className="mt-3">
          <button onClick={saveModel} disabled={saving === 'model'} className={btnPrimary} style={{ backgroundColor: '#0c4d6c' }}>
            {saving === 'model' ? 'Сохранение...' : modelSaved ? '✓ Сохранено' : 'Сохранить модель'}
          </button>
        </div>
      </SectionCard>

      <SectionCard icon={<Brain size={15} color="#fff" />} title="Память магазина">
        <p className="text-xs mb-3" style={{ color: '#8a97a5' }}>
          Знания о магазине: цены, акции, товары. Добавляются к промпту при каждом ответе.
        </p>
        <textarea rows={8} value={memory} onChange={e => setMemory(e.target.value)} className={areaCls} style={areaStyle} />
        <div className="mt-3">
          <button onClick={saveMemory} disabled={saving === 'memory'} className={btnPrimary} style={{ backgroundColor: '#0c4d6c' }}>
            {saving === 'memory' ? 'Сохранение...' : memorySaved ? '✓ Сохранено' : 'Сохранить память'}
          </button>
        </div>
      </SectionCard>

      <SectionCard icon={<MessageCircle size={15} color="#fff" />} title="Резервные уведомления Telegram">
        <p className="text-xs mb-3" style={{ color: '#8a97a5' }}>
          Эти менеджеры получают копии карточек, только когда выбран режим «CRM + Telegram» или «Только Telegram». Chat ID можно узнать у @userinfobot.
        </p>
        <div className="flex flex-wrap gap-2 mb-4">
          <input value={mgrName} onChange={e => setMgrName(e.target.value)} placeholder="Имя менеджера"
                 className="rounded-xl px-3 py-2 text-sm outline-none" style={{ ...areaStyle, flex: 1, minWidth: 150 }} />
          <input value={mgrChatId} onChange={e => setMgrChatId(e.target.value)} placeholder="Telegram Chat ID"
                 className="rounded-xl px-3 py-2 text-sm outline-none" style={{ ...areaStyle, flex: 1, minWidth: 150 }} />
          <button onClick={addManager} className={btnPrimary} style={{ backgroundColor: '#0c4d6c' }}>Добавить</button>
        </div>
        {managers.length === 0 ? (
          <p className="text-sm" style={{ color: '#8a97a5' }}>Дополнительных менеджеров нет</p>
        ) : (
          <div className="flex flex-col gap-2">
            {managers.map(m => (
              <div key={m.chat_id} className="flex items-center justify-between rounded-xl px-4 py-2.5"
                   style={{ backgroundColor: '#f5f6f8' }}>
                <div>
                  <span className="text-sm font-medium" style={{ color: '#0c2136' }}>{m.name}</span>
                  <span className="text-xs ml-2 font-mono" style={{ color: '#8a97a5' }}>{m.chat_id}</span>
                </div>
                <button onClick={() => removeManager(m)} title="Удалить"><Trash2 size={14} color="#dc2626" /></button>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  )
}
