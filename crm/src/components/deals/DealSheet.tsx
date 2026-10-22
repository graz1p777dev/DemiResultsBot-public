'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { Bot, CreditCard, Loader2, MessageCircle, PackageCheck, Send, Trash2, Truck, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import {
  deleteDeal,
  getDealConversation,
  getDealCommerce,
  saveDeal,
  sendDealMessage,
  setDealAiControl,
} from '@/actions/deals'
import type { DealCommerce } from '@/actions/deals'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import type { Deal, DealConversation, DealEmployee, DealStage } from '@/types'

interface Props {
  deal: Deal | null
  isNew: boolean
  stages: DealStage[]
  employees: DealEmployee[]
  open: boolean
  onClose: () => void
  onSaved: () => Promise<void>
}

const fieldClass = 'h-10 w-full rounded-xl border border-[#cfdee5] bg-white px-3 text-sm text-[#092a42] outline-none transition focus:border-[#1784a6] focus:ring-2 focus:ring-[#1784a6]/10'

export default function DealSheet({ deal, isNew, stages, employees, open, onClose, onSaved }: Props) {
  const defaultStage = useMemo(() => stages.find(stage => stage.is_default) ?? stages[0], [stages])
  const [title, setTitle] = useState('')
  const [stageId, setStageId] = useState('')
  const [amount, setAmount] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [responsibleId, setResponsibleId] = useState('')
  const [note, setNote] = useState('')
  const [lossReason, setLossReason] = useState('')
  const [conversation, setConversation] = useState<DealConversation | null>(null)
  const [commerce, setCommerce] = useState<DealCommerce | null>(null)
  const [chatLoading, setChatLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [saving, startSaving] = useTransition()

  const loadConversation = async (target: Deal) => {
    if (!target.amocrm_lead_id) return
    setChatLoading(true)
    const result = await getDealConversation(target.id)
    if (result.success) setConversation(result.data)
    else toast.error(result.error)
    setChatLoading(false)
  }

  useEffect(() => {
    if (!open) return
    setTitle(deal?.title ?? '')
    setStageId(deal?.stage_id ?? defaultStage?.id ?? '')
    setAmount(deal?.amount == null ? '' : String(deal.amount))
    setCustomerName(deal?.customer_name ?? '')
    setCustomerPhone(deal?.customer_phone ?? '')
    setResponsibleId(deal?.responsible_employee_id ?? '')
    setNote(deal?.note ?? '')
    setLossReason('')
    setMessage('')
    setConversation(null)
    setCommerce(null)
    if (deal) void getDealCommerce(deal.id).then(result => { if (result.success) setCommerce(result.data) })
    if (deal?.amocrm_lead_id) void loadConversation(deal)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deal?.id, defaultStage?.id])

  const submit = () => startSaving(async () => {
    const result = await saveDeal({
      id: deal?.id,
      title,
      stageId,
      amount: amount.trim() ? Number(amount) : null,
      customerName,
      customerPhone,
      responsibleEmployeeId: responsibleId || null,
      note,
      lossReasonCode: stageId && stages.find(stage => stage.id === stageId)?.kind === 'lost' ? lossReason : null,
    })
    if (!result.success) {
      toast.error(result.error)
      return
    }
    toast.success(isNew ? 'Сделка создана' : 'Сделка сохранена')
    await onSaved()
  })

  const closeDeal = (kind: 'won' | 'lost') => {
    if (!deal) return
    const target = stages.find(stage => stage.kind === kind)
    if (!target) { toast.error('Финальный этап не настроен'); return }
    if (kind === 'lost' && !window.confirm('Закрыть сделку без продажи?')) return
    startSaving(async () => {
      const result = await saveDeal({ id: deal.id, title, stageId: target.id, amount: amount.trim() ? Number(amount) : null, customerName, customerPhone, responsibleEmployeeId: responsibleId || null, note, lossReasonCode: lossReason })
      if (!result.success) { toast.error(result.error); return }
      toast.success(kind === 'won' ? 'Сделка закрыта как успешная' : 'Сделка закрыта без продажи')
      await onSaved()
    })
  }

  const remove = () => {
    if (!deal || !window.confirm(`Удалить сделку «${deal.title}»?`)) return
    startSaving(async () => {
      const result = await deleteDeal(deal.id)
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success('Сделка удалена')
      await onSaved()
    })
  }

  const send = () => {
    if (!deal || !message.trim()) return
    startSaving(async () => {
      const result = await sendDealMessage(deal.id, message)
      if (!result.success) {
        toast.error(result.error)
        return
      }
      setMessage('')
      if (result.data.aiDisabled) {
        toast.info('ИИ-бот отключён, так как вы начали общение с клиентом.', { duration: 6000 })
        setConversation(current => current ? { ...current, aiEnabled: false } : current)
      } else {
        toast.success('Сообщение отправлено клиенту')
      }
      await loadConversation(deal)
    })
  }

  const toggleAi = () => {
    if (!deal || !conversation) return
    const enabled = !conversation.aiEnabled
    setConversation({ ...conversation, aiEnabled: enabled })
    startSaving(async () => {
      const result = await setDealAiControl(deal.id, enabled)
      if (!result.success) {
        setConversation(current => current ? { ...current, aiEnabled: !enabled } : current)
        toast.error(result.error)
      } else {
        toast.success(enabled ? 'AI снова отвечает после сообщений клиента' : 'AI выключен для этой сделки')
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={value => { if (!value) onClose() }}>
      <SheetContent className="inset-0 h-[100dvh] w-screen max-w-none overflow-y-auto rounded-none border-0 bg-[#f7fafc] p-0 sm:max-w-none" showCloseButton>
        <SheetHeader className="border-b border-[#dbe8ee] bg-white px-6 py-5 pr-14">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-[#e7f5f8] text-[#075a78]">
              <MessageCircle size={20} />
            </div>
            <div>
              <SheetTitle className="text-xl font-bold text-[#092a42]">{isNew ? 'Новая сделка' : deal?.title}</SheetTitle>
              <SheetDescription>{deal?.amocrm_lead_id ? 'Сделка связана с диалогом клиента' : 'Ручная сделка Demi Results'}</SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="space-y-5 p-6">
          <section className="rounded-2xl border border-[#dbe8ee] bg-white p-5 shadow-[0_8px_28px_rgba(9,42,66,0.05)]">
            <h3 className="mb-4 text-sm font-bold text-[#092a42]">Данные сделки</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="sm:col-span-2"><span className="mb-1.5 block text-xs font-semibold text-slate-500">Название</span><input className={fieldClass} value={title} onChange={event => setTitle(event.target.value)} /></label>
              <label><span className="mb-1.5 block text-xs font-semibold text-slate-500">Этап</span><select className={fieldClass} value={stageId} onChange={event => setStageId(event.target.value)}>{stages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
              <label><span className="mb-1.5 block text-xs font-semibold text-slate-500">Сумма, сом</span><input className={fieldClass} type="number" min="0" step="0.01" value={amount} onChange={event => setAmount(event.target.value)} /></label>
              <label><span className="mb-1.5 block text-xs font-semibold text-slate-500">Клиент</span><input className={fieldClass} value={customerName} onChange={event => setCustomerName(event.target.value)} /></label>
              <label><span className="mb-1.5 block text-xs font-semibold text-slate-500">Телефон</span><input className={fieldClass} value={customerPhone} onChange={event => setCustomerPhone(event.target.value)} /></label>
              <label className="sm:col-span-2"><span className="mb-1.5 block text-xs font-semibold text-slate-500">Ответственный</span><select className={fieldClass} value={responsibleId} onChange={event => setResponsibleId(event.target.value)}><option value="">Не назначен</option>{employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
              <label className="sm:col-span-2"><span className="mb-1.5 block text-xs font-semibold text-slate-500">Заметка</span><textarea className="min-h-24 w-full resize-y rounded-xl border border-[#cfdee5] bg-white p-3 text-sm text-[#092a42] outline-none focus:border-[#1784a6] focus:ring-2 focus:ring-[#1784a6]/10" value={note} onChange={event => setNote(event.target.value)} /></label>
              {stages.find(stage => stage.id === stageId)?.kind === 'lost' && <label className="sm:col-span-2"><span className="mb-1.5 block text-xs font-semibold text-red-600">Причина отказа *</span><input required className={fieldClass} value={lossReason} onChange={event => setLossReason(event.target.value)} placeholder="Например: дорого, не отвечает, неактуально" /></label>}
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              {!isNew && <Button variant="ghost" className="text-red-600 hover:bg-red-50 hover:text-red-700" onClick={remove} disabled={saving}><Trash2 size={16} /> Удалить</Button>}
              <div className="ml-auto flex flex-wrap gap-2">
                {!isNew && stages.some(stage => stage.kind === 'lost') && <Button variant="outline" className="border-red-200 text-red-700 hover:bg-red-50" onClick={() => closeDeal('lost')} disabled={saving}>Закрыть без продажи</Button>}
                {!isNew && stages.some(stage => stage.kind === 'won') && <Button className="bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => closeDeal('won')} disabled={saving}>Успешно реализовано</Button>}
                <Button className="bg-[#075a78] text-white hover:bg-[#064b65]" onClick={submit} disabled={saving || !title.trim() || !stageId || (stages.find(stage => stage.id === stageId)?.kind === 'lost' && !lossReason.trim())}>{saving && <Loader2 size={16} className="animate-spin" />} Сохранить</Button>
              </div>
            </div>
          </section>

          {commerce && (
            <section className="rounded-2xl border border-[#dbe8ee] bg-white p-5 shadow-[0_8px_28px_rgba(9,42,66,0.05)]">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div><h3 className="text-sm font-bold text-[#092a42]">Заказ магазина №{commerce.orderNumber}</h3><p className="text-xs text-slate-500">Состав, оплата и доставка связаны со сделкой</p></div>
                <strong className="text-sm text-[#075a78]">{commerce.totalAmount.toLocaleString('ru-RU')} сом</strong>
              </div>
              <div className="mb-4 grid gap-2 sm:grid-cols-3">
                <div className="rounded-xl bg-[#f3f8fa] p-3"><PackageCheck size={16} className="mb-2 text-[#1784a6]"/><span className="block text-[10px] text-slate-500">Заказ</span><b className="text-xs text-[#092a42]">{commerce.status}</b></div>
                <div className="rounded-xl bg-[#f3f8fa] p-3"><CreditCard size={16} className="mb-2 text-[#1784a6]"/><span className="block text-[10px] text-slate-500">Оплата</span><b className="text-xs text-[#092a42]">{commerce.paymentStatus}</b></div>
                <div className="rounded-xl bg-[#f3f8fa] p-3"><Truck size={16} className="mb-2 text-[#1784a6]"/><span className="block text-[10px] text-slate-500">Доставка</span><b className="text-xs text-[#092a42]">{commerce.deliveryStatus}</b></div>
              </div>
              <div className="divide-y divide-[#e3edf1]">{commerce.items.map((item, index) => <div key={`${item.name}-${index}`} className="flex justify-between gap-3 py-2.5 text-xs"><span className="text-[#17364c]">{item.name} × {item.quantity}</span><b className="whitespace-nowrap text-[#092a42]">{item.lineTotal.toLocaleString('ru-RU')} сом</b></div>)}</div>
              {commerce.address && <p className="mt-3 text-xs text-slate-500">Адрес: {commerce.address}</p>}
            </section>
          )}

          {deal?.amocrm_lead_id && (
            <section className="overflow-hidden rounded-2xl border border-[#dbe8ee] bg-white shadow-[0_8px_28px_rgba(9,42,66,0.05)]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e3edf1] px-5 py-4">
                <div><h3 className="text-sm font-bold text-[#092a42]">Диалог с клиентом</h3><p className="text-xs text-slate-500">Сообщения клиента, менеджера и бота по времени</p></div>
                <div className="flex items-center gap-2">
                  {conversation && <button onClick={toggleAi} disabled={saving} className={cn('inline-flex h-9 items-center gap-2 rounded-xl px-3 text-xs font-bold transition', conversation.aiEnabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500')}><Bot size={15} /> AI {conversation.aiEnabled ? 'включён' : 'выключен'}</button>}
                </div>
              </div>
              <div className="max-h-[430px] space-y-3 overflow-y-auto bg-[#f3f8fa] p-4">
                {chatLoading && <div className="flex justify-center py-10 text-[#1784a6]"><Loader2 className="animate-spin" /></div>}
                {!chatLoading && conversation?.messages.map(item => {
                  const incoming = item.speaker === 'client' || item.role === 'user'
                  const label = incoming ? 'Клиент' : item.speaker === 'bot' ? 'Бот' : item.author_name || 'Менеджер'
                  return <div key={String(item.id)} className={cn('flex', incoming ? 'justify-start' : 'justify-end')}><div className={cn('max-w-[84%] rounded-2xl px-3.5 py-2.5 shadow-sm', incoming ? 'rounded-bl-md border border-[#dbe8ee] bg-white text-[#17364c]' : item.speaker === 'bot' ? 'rounded-br-md bg-[#dff3f7] text-[#0c5067]' : 'rounded-br-md bg-[#075a78] text-white')}><div className={cn('mb-1 flex items-center gap-1 text-[10px] font-bold', incoming ? 'text-slate-400' : item.speaker === 'bot' ? 'text-[#1784a6]' : 'text-white/65')}>{incoming ? <UserRound size={11} /> : <Bot size={11} />}{label}</div><p className="whitespace-pre-wrap text-sm leading-relaxed">{item.text}</p>{item.created_at && <p className={cn('mt-1 text-right text-[10px]', incoming ? 'text-slate-400' : item.speaker === 'bot' ? 'text-[#1784a6]/70' : 'text-white/55')}>{new Date(item.created_at).toLocaleString('ru-RU', { timeZone: 'Asia/Bishkek', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>}</div></div>
                })}
                {!chatLoading && conversation && conversation.messages.length === 0 && <p className="py-10 text-center text-sm text-slate-400">В диалоге пока нет сообщений</p>}
              </div>
              <div className="flex gap-2 border-t border-[#e3edf1] bg-white p-4"><textarea value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() } }} placeholder="Написать клиенту от имени менеджера…" className="min-h-11 flex-1 resize-none rounded-xl border border-[#cfdee5] px-3 py-2.5 text-sm outline-none focus:border-[#1784a6] focus:ring-2 focus:ring-[#1784a6]/10" /><Button size="icon" className="size-11 shrink-0 bg-[#075a78] text-white hover:bg-[#064b65]" onClick={send} disabled={saving || !message.trim()}><Send size={17} /></Button></div>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
