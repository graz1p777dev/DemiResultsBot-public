import { createCrmField, deleteCrmField, getCrmFields } from '@/actions/crm-fields'
import { getActor } from '@/lib/authz'
import { redirect } from 'next/navigation'

export default async function CrmFieldsPage() {
  const actor = await getActor()
  if (!actor) redirect('/auth/login')
  if (actor.role !== 'owner') redirect('/dashboard/settings')
  const fields = await getCrmFields()
  return <main className="min-h-screen bg-[#f5f6f8] p-6"><h1 className="mb-1 text-2xl font-bold text-[#0c2136]">Поля CRM</h1><p className="mb-6 text-sm text-slate-500">Настраиваемые поля контактов и сделок</p><section className="max-w-3xl rounded-2xl bg-white p-5"><form action={createCrmField} className="grid gap-3 sm:grid-cols-4"><input name="label" required placeholder="Название" className="rounded-xl border p-2 text-sm"/><input name="key" required placeholder="Ключ" className="rounded-xl border p-2 text-sm"/><select name="entity" className="rounded-xl border p-2 text-sm"><option value="client">Контакт</option><option value="deal">Сделка</option></select><select name="field_type" className="rounded-xl border p-2 text-sm"><option value="text">Текст</option><option value="number">Число</option><option value="date">Дата</option><option value="boolean">Да/нет</option><option value="select">Список</option></select><button className="rounded-xl bg-[#075a78] px-4 py-2 text-sm font-semibold text-white sm:col-span-4 sm:justify-self-end">Добавить поле</button></form></section><section className="mt-5 max-w-3xl rounded-2xl bg-white p-5"><h2 className="mb-3 font-semibold">Настроенные поля</h2>{fields.length===0?<p className="text-sm text-slate-500">Поля ещё не созданы.</p>:fields.map(field=><div key={field.id} className="flex justify-between border-t py-3 text-sm"><span><b>{field.label}</b><small className="ml-2 text-slate-400">{field.entity==='client'?'Контакт':'Сделка'} · {field.key}</small></span><form action={deleteCrmField.bind(null,field.id)}><button className="text-red-600">Удалить</button></form></div>)}</section></main>
}
